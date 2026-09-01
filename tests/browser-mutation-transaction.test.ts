import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ensureChatGptPersonalizedConnectorAccess } from "../src/adapters/chatgpt-web/personalization";
import { ChatGptPersistentBrowserStateError } from "../src/browser-mutation";

test("a cancelled mutating stage settles its owned cleanup before returning", async () => {
  const owner = new AbortController();
  let cleanupSettled = false;
  const runStage = (ChatGptBrowserWorker.prototype as unknown as {
    runStage<T>(
      traceId: string,
      stage: string,
      timeoutMs: number,
      action: (signal: AbortSignal) => Promise<T>,
      ownerSignal?: AbortSignal,
      suspensionClock?: { suspendedMs(): number },
      awaitAbortedActionSettlement?: boolean,
    ): Promise<T>;
  }).runStage;

  const result = runStage.call({}, "mutation_abort", "prompt_attachment", 60_000, signal => (
    new Promise<string>(resolve => signal.addEventListener("abort", () => {
      setTimeout(() => {
        cleanupSettled = true;
        resolve("rolled back");
      }, 20);
    }, { once: true }))
  ), owner.signal, undefined, true);
  owner.abort();

  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(cleanupSettled).toBeTrue();
});

test("cleanup integrity failures supersede the original cancellation", async () => {
  const owner = new AbortController();
  const runStage = (ChatGptBrowserWorker.prototype as unknown as {
    runStage<T>(
      traceId: string, stage: string, timeoutMs: number,
      action: (signal: AbortSignal) => Promise<T>, ownerSignal?: AbortSignal,
      suspensionClock?: { suspendedMs(): number }, awaitAbortedActionSettlement?: boolean,
    ): Promise<T>;
  }).runStage;
  const result = runStage.call({}, "mutation_cleanup", "prompt_attachment", 60_000, signal => (
    new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => {
      reject(new ChatGptPersistentBrowserStateError(
        [new Error("rollback failed")],
        "persistent browser cleanup failed",
      ));
    }, { once: true }))
  ), owner.signal, undefined, true);
  owner.abort();

  await expect(result).rejects.toMatchObject({
    name: "ChatGptPersistentBrowserStateError",
    message: "persistent browser cleanup failed",
  });
});

test("aborted personalization restores the original semantic mode", async () => {
  const owner = new AbortController();
  let selectedMode = 1;
  let menuOpen = false;
  let proofCalls = 0;
  const absent = { filter: () => absent, count: async () => 0 };
  const control = {
    waitFor: async () => {},
    click: async () => { menuOpen = true; },
    getAttribute: async (name: string) => name === "aria-controls" ? "personalization-menu" : null,
  };
  const controls = { filter: () => controls, first: () => control, count: async () => 1 };
  const item = (index: number) => ({
    getAttribute: async (name: string) => name === "aria-checked"
      ? String(selectedMode === index)
      : selectedMode === index ? "checked" : "unchecked",
    click: async () => {
      selectedMode = index;
      menuOpen = false;
    },
  });
  const items = { filter: () => items, count: async () => 2, nth: (index: number) => item(index) };
  const menu = {
    waitFor: async ({ state }: { state: string }) => {
      expect(menuOpen).toBe(state === "visible");
    },
    locator: () => items,
  };
  const body = { press: async () => { menuOpen = false; } };
  const page = {
    getByRole: () => absent,
    locator: (selector: string) => selector === "body"
      ? body
      : selector.includes("aria-haspopup") ? controls : menu,
  };

  await expect(ensureChatGptPersonalizedConnectorAccess(
    page as never,
    undefined,
    async () => {
      proofCalls += 1;
      if (proofCalls === 1) return false;
      owner.abort();
      throw new DOMException("aborted", "AbortError");
    },
    owner.signal,
  ))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(selectedMode).toBe(1);
  expect(menuOpen).toBeFalse();
});

test("semantic Unpersonalized state enables its owned Personalized choice", async () => {
  let personalized = false;
  let menuOpen = false;
  const events: string[] = [];
  const named = (name: string) => ({
    filter: () => named(name),
    count: async () => name === "Personalized" ? Number(personalized) : Number(!personalized),
    click: async () => { menuOpen = true; events.push("open"); },
    getAttribute: async (attribute: string) => attribute === "aria-controls" ? "owned-menu" : null,
    waitFor: async ({ state }: { state: string }) => {
      const present = name === "Personalized" ? personalized : !personalized;
      expect(state === "visible" ? present : !present).toBeTrue();
    },
  });
  const choice = {
    count: async () => 1,
    click: async () => {
      personalized = true;
      menuOpen = false;
      events.push("enable");
    },
  };
  const menu = {
    waitFor: async ({ state }: { state: string }) => {
      expect(state === "visible" ? menuOpen : !menuOpen).toBeTrue();
    },
    locator: () => ({ filter: () => choice }),
  };
  const page = {
    getByRole: (_role: string, options: { name: string }) => named(options.name),
    locator: (selector: string) => {
      if (selector === "body") return { press: async () => { menuOpen = false; } };
      expect(selector).toBe('[id="owned-menu"]');
      return menu;
    },
  };

  const result = await ensureChatGptPersonalizedConnectorAccess(
    page as never,
    async event => { events.push(event); },
  );
  expect(result).toBe("enabled");
  expect(personalized).toBeTrue();
  expect(events).toEqual(["personalization-unpersonalized", "open", "enable", "personalization-enabled"]);
});
