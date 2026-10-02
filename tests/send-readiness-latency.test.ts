import { expect, spyOn, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

test.each([false, true])("Send polls only when the attached composer is disabled (disabled=%s)", async disabled => {
  const fixture = sendFixture(disabled);
  const waits: number[] = [];
  const schedule = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
    waits.push(ms); return schedule(callback, 0);
  }) as typeof setTimeout);
  try {
    expect(await fixture.send()).toBe("assistant_turn");
    expect(waits.filter(ms => ms > 0)).toHaveLength(disabled ? 1 : 0);
    expect(fixture.actions).toEqual(disabled
      ? ["enabled", "enabled", "verify", "activate", "send", "accepted"]
      : ["enabled", "verify", "activate", "send", "accepted"]);
  } finally { timer.mockRestore(); }
});

test("an expired session cannot reach Send even when the button is enabled", async () => {
  const fixture = sendFixture(false, true);
  await expect(fixture.send()).rejects.toMatchObject({ code: "chatgpt_session_expired" });
  expect(fixture.actions).toEqual([]);
});

test("pre-Send exact readback failure cannot activate a ready button", async () => {
  const fixture = sendFixture(false, false, true);
  await expect(fixture.send()).rejects.toThrow("Prompt mismatch");
  expect(fixture.actions).toEqual(["enabled", "verify"]);
});

test.each([5_250, 5_500])("disabled Send retains its original grace boundary (ready after %sms)", async readyAfterMs => {
  let now = 1_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const schedule = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
    now += ms; return schedule(callback, 0);
  }) as typeof setTimeout);
  try {
    const fixture = sendFixture(true, false, false, readyAfterMs);
    if (readyAfterMs === 5_250) {
      expect(await fixture.send()).toBe("assistant_turn");
      expect(fixture.actions).toContain("send");
    } else {
      await expect(fixture.send()).rejects.toThrow("send button remained disabled");
      expect(fixture.actions).not.toContain("activate");
    }
    expect(now).toBe(6_250);
  } finally { timer.mockRestore(); clock.mockRestore(); }
});

function sendFixture(disabled: boolean, expired = false, mismatch = false, readyAfterMs?: number) {
  const actions: string[] = [];
  let checks = 0;
  const startedAt = Date.now();
  const hidden: any = { last: () => hidden, isVisible: async () => false,
    filter: ({ hasText }: { hasText: RegExp }) => expired && hasText.test("Your session has expired")
      ? { last: () => ({ isVisible: async () => true }) } : hidden };
  const sendButton = { waitFor: async () => {},
    isEnabled: async () => { actions.push("enabled"); return readyAfterMs === undefined
      ? !disabled || checks++ > 0 : Date.now() - startedAt >= readyAfterMs; },
    press: async () => { actions.push("send"); } };
  const composer = { locator: () => ({ locator: () => sendButton }) };
  const worker: any = Object.create(ChatGptBrowserWorker.prototype);
  worker.activeComposer = async () => composer;
  worker.assertPromptAttached = async () => {
    actions.push("verify"); if (mismatch) throw new Error("Prompt mismatch");
  };
  worker.waitForSubmissionAccepted = async () => { actions.push("accepted"); return "assistant_turn"; };
  return { actions, send: () => worker.sendAttachedPrompt(
    { locator: () => hidden, isClosed: () => false },
    { responseTurns: { nth: () => ({}) }, initialTurnIdentities: [] },
    { count: 0 }, undefined, undefined, () => { actions.push("activate"); },
    undefined, undefined, "Exact prompt",
  ) };
}
