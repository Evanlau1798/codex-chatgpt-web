import { expect, test } from "bun:test";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { requestRetainedCompactionHandoff } from "../src/adapters/chatgpt-web/retained-compaction-handoff";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import type { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { CodexParsedRequest } from "../src/types";
import { deferred } from "../src/adapters/chatgpt-web/runtime-lifecycle";

const parsed: CodexParsedRequest = {
  modelId: "chatgpt-web", stream: true,
  context: { messages: [{ role: "user", content: "Continue", timestamp: 1 }] },
  options: { reasoning: "high" }, _compactionRequest: true,
};

test("retained compaction closes its one-purpose Web response after accepting the checkpoint", async () => {
  const accepted = deferred<void>();
  const browser = deferred<string>();
  const broker = {
    beginCompactionTransaction: async () => ({ token: "control", handoffId: "handoff" }),
    waitForCompactionHandoff: async () => { accepted.resolve(); return "Structured retained checkpoint is valid."; },
    abortCompactionTransaction() {},
  } as unknown as TurnBroker;
  const source = new ChatGptTurnSession({
    mode: "read-only", browser: Promise.resolve("source completed"),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    conversationKey: "a".repeat(64), cancel() {},
  });
  let turn: BrowserTurn | undefined;
  let browserAborted = false;
  const worker = { run: (value: BrowserTurn) => {
    turn = value;
    value.abortSignal?.addEventListener("abort", () => {
      browserAborted = true;
      browser.reject(new DOMException("retired", "AbortError"));
    }, { once: true });
    return browser.promise;
  } };

  let completed = false;
  const run = requestRetainedCompactionHandoff(
    worker as never, parsed, source, broker,
    { localToolsEnabled: true, solAvailable: true, proAvailable: true }, "trace_retained",
  ).then(value => { completed = true; return value; });
  try {
    await accepted.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(browserAborted).toBeTrue();
    await expect(run).resolves.toBe("Structured retained checkpoint is valid.");
    expect(completed).toBeTrue();
    expect(turn?.conversationKey).toBe("a".repeat(64));
    expect(turn?.nativeConnector).toBeTrue();
    expect(turn?.requireRetainedConversation).toBeTrue();
    expect(turn?.prepareResume).toBeDefined();
    expect(browserAborted).toBeTrue();
  } finally { browser.resolve("cleanup"); await run.catch(() => {}); }
});

test("retained compaction requires an attached conversation", async () => {
  const source = new ChatGptTurnSession({
    mode: "read-only", browser: Promise.resolve("done"),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {},
  });
  await expect(requestRetainedCompactionHandoff(
    { run: async () => "unused" } as never, parsed, source, {} as TurnBroker,
    { localToolsEnabled: true, solAvailable: true, proAvailable: true }, "trace_missing",
  )).rejects.toThrow("retained ChatGPT conversation");
});
