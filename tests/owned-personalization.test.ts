import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { registerOwnedChatGptWorkPage, recoverOwnedTemporaryPersonalization } from "../src/adapters/chatgpt-web/owned-personalization";
import { ensureChatGptPersonalizedConnectorAccess } from "../src/adapters/chatgpt-web/personalization";

function fixture(options: { url?: string; gate?: boolean; layer?: boolean; ready?: boolean; clients?: number; notifyFails?: boolean } = {}) {
  let notifications = 0, evaluations = 0;
  const listeners = new Map<string, () => void>();
  const location = { href: options.url ?? "https://chatgpt.com/?temporary-chat=true" };
  const original = (name: string) => ({ value: name === "2958953032" ? options.gate === true : false, ruleID: "original" });
  const client = { loadingStatus: options.ready === false ? "Loading" : "Ready", getFeatureGate: original,
    getLayer: () => ({ get: () => options.layer !== false }),
    $emt: () => { notifications++; if (options.notifyFails) throw new Error("notification failed"); } };
  const descriptor = Object.getOwnPropertyDescriptor(client, "getFeatureGate");
  const w: any = { __STATSIG__: { firstInstance: client,
    instances: options.clients === 2 ? { first: client, second: client } : { first: client } },
    addEventListener: (name: string, cb: () => void) => listeners.set(name, cb),
    removeEventListener: (name: string) => listeners.delete(name) };
  const page: any = { evaluate: async (fn: Function) => {
    evaluations++; return runInNewContext(`(${fn.toString()})();`, { window: w, location, URL });
  } };
  return { page, client, descriptor, w, location, listeners,
    evaluations: () => evaluations, notifications: () => notifications };
}

test("unowned pages are never evaluated or changed", async () => {
  const f = fixture();
  expect(await recoverOwnedTemporaryPersonalization(f.page)).toBe(false);
  expect(f.evaluations()).toBe(0);
  expect(f.client.getFeatureGate).toBe(f.descriptor!.value);
});

test("an owned Temporary work page enables only the verified eligibility gate in memory", async () => {
  const f = fixture(); registerOwnedChatGptWorkPage(f.page);
  expect(await recoverOwnedTemporaryPersonalization(f.page)).toBe(true);
  expect(f.client.getFeatureGate("2958953032")).toMatchObject({ value: true, ruleID: "original" });
  expect(f.client.getFeatureGate("other").value).toBe(false);
  expect(f.notifications()).toBe(1);
  expect(await recoverOwnedTemporaryPersonalization(f.page)).toBe(true);
  expect(f.notifications()).toBe(1);
});

test.each(["https://chatgpt.com/", "https://chatgpt.com/c/saved", "https://other.example/?temporary-chat=true",
  "http://chatgpt.com/?temporary-chat=true", "https://chatgpt.com/settings?temporary-chat=true"])("never overrides a foreign/non-Temporary surface %s", async url => {
  const f = fixture({ url }); registerOwnedChatGptWorkPage(f.page);
  expect(await recoverOwnedTemporaryPersonalization(f.page)).toBe(false);
  expect(f.client.getFeatureGate).toBe(f.descriptor!.value);
  expect(f.notifications()).toBe(0);
});

test.each([{ ready: false }, { layer: false }, { clients: 2 }, { gate: true }])("unknown, disabled or already enabled state remains unchanged %j", async options => {
  const f = fixture(options); registerOwnedChatGptWorkPage(f.page);
  expect(await recoverOwnedTemporaryPersonalization(f.page)).toBe(false);
  expect(f.client.getFeatureGate).toBe(f.descriptor!.value);
  expect(f.notifications()).toBe(0);
});

test("navigation out of Temporary never overrides the gate; pagehide restores the exact descriptor", async () => {
  const f = fixture(); registerOwnedChatGptWorkPage(f.page);
  expect(await recoverOwnedTemporaryPersonalization(f.page)).toBe(true);
  f.location.href = "https://chatgpt.com/c/saved";
  expect(f.client.getFeatureGate("2958953032").value).toBe(false);
  f.listeners.get("pagehide")!();
  expect(Object.getOwnPropertyDescriptor(f.client, "getFeatureGate")).toEqual(f.descriptor);
  expect(f.listeners.size).toBe(0);
});

test("SDK notification failure rolls back the getter and never fabricates success", async () => {
  const f = fixture({ notifyFails: true }); registerOwnedChatGptWorkPage(f.page);
  expect(await recoverOwnedTemporaryPersonalization(f.page)).toBe(false);
  expect(f.client.getFeatureGate).toBe(f.descriptor!.value);
  expect(f.listeners.size).toBe(0);
});

test("the real personalization preflight verifies native controls after owned-page recovery", async () => {
  const f = fixture(); registerOwnedChatGptWorkPage(f.page);
  f.page.getByRole = (_role: string, { name }: { name: RegExp }) => {
    const locator = { filter: () => locator,
      count: async () => Number(name.test("Personalized") && f.client.getFeatureGate("2958953032").value) };
    return locator;
  };
  const diagnostics: string[] = [];
  const result = await ensureChatGptPersonalizedConnectorAccess(f.page,
    async checkpoint => { diagnostics.push(checkpoint); }, undefined, undefined,
    () => recoverOwnedTemporaryPersonalization(f.page));
  expect(result).toBe("already-personalized");
  expect(diagnostics).toEqual(["personalization-owned-experiment-enabled", "personalization-already-enabled"]);
  expect(f.notifications()).toBe(1);
});

test("native controls keep the recovery callback dormant and abort prevents a page mutation", async () => {
  const f = fixture(); let attempts = 0;
  f.page.getByRole = (_role: string, { name }: { name: RegExp }) => {
    const locator = { filter: () => locator, count: async () => Number(name.test("Personalized")) };
    return locator;
  };
  expect(await ensureChatGptPersonalizedConnectorAccess(f.page, undefined, undefined, undefined,
    async () => { attempts++; return true; })).toBe("already-personalized");
  expect(attempts).toBe(0);
  const abort = new AbortController(); abort.abort();
  await expect(ensureChatGptPersonalizedConnectorAccess(f.page, undefined, undefined, abort.signal,
    async () => { attempts++; return true; })).rejects.toBeDefined();
  expect(attempts).toBe(0);
});
