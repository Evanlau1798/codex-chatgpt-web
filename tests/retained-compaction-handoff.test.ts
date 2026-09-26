import { expect, test } from "bun:test";
import { chatGptRetainedSurfaceUnavailableError } from "../src/adapters/chatgpt-web/adapter-error";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { requestRetainedCompactionHandoff } from "../src/adapters/chatgpt-web/retained-compaction-handoff";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import type { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { CodexParsedRequest } from "../src/types";
import { deferred } from "../src/adapters/chatgpt-web/runtime-lifecycle";

const parsed: CodexParsedRequest = {
  modelId: "chatgpt-web", stream: true,
  context: { messages: [{ role: "user", content: "Inspect", timestamp: 1 }] },
  options: { reasoning: "high" }, _compactionRequest: true,
};

function source(): ChatGptTurnSession {
  return new ChatGptTurnSession({
    mode: "read-only", browser: Promise.resolve("done"),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    conversationKey: "b".repeat(64), cancel() {},
  });
}

for (const accepted of [false, true]) test(`retained deadline bounds an uncooperative browser (checkpoint accepted: ${accepted})`, async () => {
  const browser = deferred<string>();
  let transactionAborted = false;
  let browserAborted = false;
  const broker = {
    beginCompactionTransaction: async () => ({ token: "control", handoffId: "handoff" }),
    waitForCompactionHandoff: () => accepted ? Promise.resolve("Already submitted checkpoint") : new Promise<string>(() => {}),
    abortCompactionTransaction: () => { transactionAborted = true; },
  } as unknown as TurnBroker;
  const run = requestRetainedCompactionHandoff({ run: turn => {
    turn.abortSignal!.addEventListener("abort", () => { browserAborted = true; }, { once: true });
    return browser.promise;
  } }, parsed, source(), broker,
  { localToolsEnabled: true, solAvailable: true, proAvailable: true }, "trace_deadline", undefined, 25)
    .then(() => new Error("Unexpected success"), error => error);
  try {
    const failure = await Promise.race([run, Bun.sleep(250).then(() => new Error("Deadline did not return"))]);
    expect(failure.message).toContain("timed out after 25ms");
    expect(transactionAborted).toBeTrue();
    expect(browserAborted).toBeTrue();
  } finally { browser.resolve("cleanup"); await run; }
});

test("structured handoff ignores browser text and uses only the control result", async () => {
  let turn: BrowserTurn | undefined;
  const worker = { run: (value: BrowserTurn) => {
    turn = value;
    return Promise.resolve("turn complete");
  } };
  const broker = {
    beginCompactionTransaction: async () => ({ token: "control", handoffId: "handoff" }),
    waitForCompactionHandoff: async () => "canonical checkpoint",
    abortCompactionTransaction() {},
  } as unknown as TurnBroker;

  await expect(requestRetainedCompactionHandoff(
    worker as never, parsed, source(), broker,
    { localToolsEnabled: true, solAvailable: true, proAvailable: true }, "trace_control",
  )).resolves.toBe("canonical checkpoint");
  const prepared = await turn!.prepare();
  expect(prepared.text).toContain("codex.control.compaction_handoff");
  expect(prepared.text).not.toContain("Inspect");
  expect(turn?.capabilities.localToolsEnabled).toBeFalse();
  expect(turn?.compaction).toBeTrue();
});

test("retained handoff rechecks automatic admission immediately before browser start", async () => {
  let runs = 0;
  let blocked: unknown;
  const worker = { run: async () => {
    runs += 1;
    return "unexpected browser start";
  } };
  const broker = {
    beginCompactionTransaction: async () => ({ token: "control", handoffId: "handoff" }),
    waitForCompactionHandoff: async () => "unexpected checkpoint",
    abortCompactionTransaction() {},
  } as unknown as TurnBroker;

  try {
    await requestRetainedCompactionHandoff(
      worker as never, parsed, source(), broker,
      { localToolsEnabled: true, solAvailable: true, proAvailable: true }, "trace_blocked",
      undefined, undefined,
      targetTraceId => { throw new Error(`blocked ${targetTraceId}`); },
    );
  } catch (error) {
    blocked = error;
  }

  expect(runs).toBe(0);
  expect(blocked).toMatchObject({ message: "blocked trace_blocked" });
});

test("handoff deadline aborts and cleans up a cooperating browser", async () => {
  let cleaned = false;
  const worker = { run: (turn: BrowserTurn) => new Promise<string>((_resolve, reject) => {
    turn.abortSignal?.addEventListener("abort", () => {
      cleaned = true;
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  }) };
  const broker = {
    beginCompactionTransaction: async () => ({ token: "control", handoffId: "handoff" }),
    waitForCompactionHandoff: () => new Promise<string>(() => {}),
    abortCompactionTransaction() {},
  } as unknown as TurnBroker;

  await expect(requestRetainedCompactionHandoff(
    worker as never, parsed, source(), broker,
    { localToolsEnabled: true, solAvailable: true, proAvailable: true }, "trace_timeout", undefined, 20,
  )).rejects.toThrow("timed out");
  expect(cleaned).toBeTrue();
});

test("pre-submit retained surface loss is exposed to the single outer fallback", async () => {
  const worker = {
    run: async () => {
      throw chatGptRetainedSurfaceUnavailableError(new Error("fixture surface drift"));
    },
  };
  const broker = {
    beginCompactionTransaction: async () => ({ token: "control", handoffId: "handoff" }),
    waitForCompactionHandoff: () => new Promise<string>(() => {}),
    abortCompactionTransaction() {},
  } as unknown as TurnBroker;

  await expect(requestRetainedCompactionHandoff(
    worker as never, parsed, source(), broker,
    { localToolsEnabled: true, solAvailable: true, proAvailable: true }, "trace_surface_loss",
  )).rejects.toMatchObject({ name: "RetainedCompactionSourceUnavailableError" });
});

test("retained browser completion without a structured handoff fails immediately", async () => {
  const worker = { run: async () => "turn complete" };
  const broker = {
    beginCompactionTransaction: async () => ({ token: "control", handoffId: "handoff" }),
    waitForCompactionHandoff: () => new Promise<string>(() => {}),
    abortCompactionTransaction() {},
  } as unknown as TurnBroker;

  await expect(requestRetainedCompactionHandoff(
    worker as never, parsed, source(), broker,
    { localToolsEnabled: true, solAvailable: true, proAvailable: true }, "trace_missing_handoff", undefined, 40,
  )).rejects.toMatchObject({ code: "compaction_handoff_missing", retryable: false });
});
