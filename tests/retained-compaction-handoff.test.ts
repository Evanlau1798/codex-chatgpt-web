import { expect, test } from "bun:test";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { requestRetainedCompactionHandoff } from "../src/adapters/chatgpt-web/retained-compaction-handoff";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import type { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { CodexParsedRequest } from "../src/types";

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

test("structured handoff ignores browser text and uses only the control result", async () => {
  let turn: BrowserTurn | undefined;
  const worker = { run: (value: BrowserTurn) => {
    turn = value;
    return new Promise<string>((_resolve, reject) => value.abortSignal?.addEventListener("abort", () => {
      reject(new DOMException("retired", "AbortError"));
    }, { once: true }));
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
