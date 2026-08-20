import { expect, test } from "bun:test";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import type { BrowserTurn, ResolvedBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";

interface PendingFixture {
  turn: BrowserTurn;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  sent?: boolean;
}

interface ClientFixture {
  child?: unknown;
  pending: Map<string, PendingFixture>;
  handleLine(child: unknown, line: string): void;
  send(message: unknown): Promise<void>;
}

function turn(traceId: string, overrides: Partial<BrowserTurn> = {}): BrowserTurn {
  return {
    traceId,
    modelId: "chatgpt-web/medium",
    capabilities: { localToolsEnabled: true, solAvailable: true, proAvailable: false },
    prepare: async () => ({ text: "inspect", images: [], release() {} }),
    onTextDelta() {},
    ...overrides,
  };
}

function fixture() {
  const client = new LauncherBrowserHelperClient({} as ResolvedBrowserConfig);
  const internal = client as unknown as ClientFixture;
  const child = {};
  const sent: unknown[] = [];
  internal.child = child;
  internal.send = async message => { sent.push(message); };
  return { client, internal, child, sent };
}

test("a deferred retry callback cannot write into a reused trace", async () => {
  const { internal, child, sent } = fixture();
  let finishRetry!: (value: string) => void;
  const retry = new Promise<string>(resolve => { finishRetry = resolve; });
  const traceId = "reused-trace-123";
  internal.pending.set(traceId, {
    turn: turn(traceId, { retryPromptForAnswer: () => retry }),
    resolve() {}, reject() {}, sent: true,
  });

  internal.handleLine(child, JSON.stringify({
    type: "event", id: traceId, event: "answer", text: "old answer", attempt: 1,
  }));
  await Bun.sleep(0);
  internal.handleLine(child, JSON.stringify({ type: "result", id: traceId, text: "old done" }));
  const replacement: PendingFixture = { turn: turn(traceId), resolve() {}, reject() {}, sent: true };
  internal.pending.set(traceId, replacement);

  finishRetry("stale retry");
  await Bun.sleep(0);
  expect(sent).toEqual([]);
  expect(internal.pending.get(traceId)).toBe(replacement);
});

test("a synchronous event callback failure aborts only its owning helper turn", async () => {
  const { internal, child, sent } = fixture();
  const traceId = "callback-failure-123";
  let rejected: Error | undefined;
  internal.pending.set(traceId, {
    turn: turn(traceId, { onTextDelta: () => { throw new Error("consumer callback failed"); } }),
    resolve() {}, reject(error) { rejected = error; }, sent: true,
  });

  expect(() => internal.handleLine(child, JSON.stringify({
    type: "event", id: traceId, event: "text", text: "delta",
  }))).not.toThrow();
  await Bun.sleep(0);
  expect(sent).toEqual([{ type: "abort", id: traceId }]);
  expect(internal.pending.has(traceId)).toBeTrue();

  internal.handleLine(child, JSON.stringify({ type: "result", id: traceId, text: "ignored" }));
  expect(rejected?.message).toBe("consumer callback failed");
  expect(internal.pending.has(traceId)).toBeFalse();
});

test("a stale preempt write failure cannot abort a reused trace", async () => {
  const { client, internal, child, sent } = fixture();
  let rejectPreempt!: (error: Error) => void;
  internal.send = message => {
    sent.push(message);
    return (message as { type?: string }).type === "preempt_retry"
      ? new Promise<void>((_, reject) => { rejectPreempt = reject; })
      : Promise.resolve();
  };
  const traceId = "stale-preempt-write-123";
  internal.pending.set(traceId, { turn: turn(traceId), resolve() {}, reject() {}, sent: true });

  expect(client.requestPreemptiveRetry(traceId, "checkpoint now")).toBeTrue();
  internal.handleLine(child, JSON.stringify({ type: "result", id: traceId, text: "old done" }));
  const replacement: PendingFixture = { turn: turn(traceId), resolve() {}, reject() {}, sent: true };
  internal.pending.set(traceId, replacement);

  rejectPreempt(new Error("old pipe write failed"));
  await Bun.sleep(0);
  expect(sent).toEqual([{ type: "preempt_retry", id: traceId, prompt: "checkpoint now" }]);
  expect(internal.pending.get(traceId)).toBe(replacement);
});

test("a deferred prepared-selection callback cannot acknowledge a reused trace", async () => {
  const { internal, child, sent } = fixture();
  let finishSelected!: () => void;
  const selected = new Promise<void>(resolve => { finishSelected = resolve; });
  const traceId = "stale-prepared-selection-123";
  let releases = 0;
  internal.pending.set(traceId, {
    turn: turn(traceId, {
      prepare: async () => ({ text: "old prompt", images: [], release() { releases += 1; } }),
      onPreparedSelected: () => selected,
    }),
    resolve() {}, reject() {}, sent: true,
  });

  internal.handleLine(child, JSON.stringify({
    type: "event", id: traceId, event: "prepared_selected", reused: false,
  }));
  await Bun.sleep(0);
  internal.handleLine(child, JSON.stringify({ type: "result", id: traceId, text: "old done" }));
  const replacement: PendingFixture = { turn: turn(traceId), resolve() {}, reject() {}, sent: true };
  internal.pending.set(traceId, replacement);

  finishSelected();
  await Bun.sleep(0);
  expect(sent).toEqual([]);
  expect(releases).toBe(1);
  expect(internal.pending.get(traceId)).toBe(replacement);
});
