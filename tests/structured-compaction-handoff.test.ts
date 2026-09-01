import { expect, test } from "bun:test";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { requestRetainedCompactionHandoff } from "../src/adapters/chatgpt-web/retained-compaction-handoff";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import type { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { CodexParsedRequest } from "../src/types";

const parsed: CodexParsedRequest = {
  modelId: "chatgpt-web", stream: true,
  context: { messages: [{ role: "user", content: "Continue", timestamp: 1 }] },
  options: { reasoning: "high" }, _compactionRequest: true,
};

test("retained compaction submits one structured checkpoint and closes its browser turn", async () => {
  const broker = {
    beginCompactionTransaction: async () => ({ token: "control", handoffId: "handoff" }),
    waitForCompactionHandoff: async () => "Structured retained checkpoint is valid.",
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
    return new Promise<string>((_resolve, reject) => value.abortSignal?.addEventListener("abort", () => {
      browserAborted = true;
      reject(new DOMException("retired", "AbortError"));
    }, { once: true }));
  } };

  await expect(requestRetainedCompactionHandoff(
    worker as never, parsed, source, broker,
    { localToolsEnabled: true, solAvailable: true, proAvailable: true }, "trace_retained",
  )).resolves.toBe("Structured retained checkpoint is valid.");
  expect(turn?.conversationKey).toBe("a".repeat(64));
  expect(turn?.nativeConnector).toBeTrue();
  expect(turn?.requireRetainedConversation).toBeTrue();
  expect(turn?.prepareResume).toBeDefined();
  expect(browserAborted).toBeTrue();
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
