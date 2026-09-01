import { expect, test } from "bun:test";
import {
  existingStructuredCompactionRun,
  runStructuredCompactionOnce,
  settleActiveCompactionSource,
} from "../src/adapters/chatgpt-web/compaction-handoff";
import { ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-session-registry";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import type { BrokerToolResult, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { CodexParsedRequest } from "../src/types";

function compactionRequest(): CodexParsedRequest {
  return {
    modelId: "chatgpt-web",
    stream: true,
    context: { messages: [
      { role: "user", content: "Continue", timestamp: 1 },
      { role: "toolResult", toolCallId: "call_one", toolName: "exec_command", content: "one", isError: false, timestamp: 2 },
      { role: "toolResult", toolCallId: "call_two", toolName: "exec_command", content: "two", isError: false, timestamp: 3 },
    ] },
    options: { reasoning: "high" },
    _compactionRequest: true,
  };
}

test("active compaction settles canonical tool results before a separate retained handoff", async () => {
  const completed: Array<{ callId: string; result: BrokerToolResult }> = [];
  let finish!: (answer: string) => void;
  const browser = new Promise<string>(resolve => { finish = resolve; });
  const source = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve("turn_active"),
    browser,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    externalProgress: { recordToolBatch() {}, recordToolResult() {} } as never,
    cancel() {},
  });
  source.setOutstanding([
    { callId: "call_one", wireName: "exec_command", freeform: false },
    { callId: "call_two", wireName: "exec_command", freeform: false },
  ]);
  const broker = {
    requestCompaction: () => 0,
    compactionDeliveryCount: () => 0,
    completeTool: (_token: string, callId: string, result: BrokerToolResult) => {
      completed.push({ callId, result });
      if (callId === "call_two") finish("Ordinary final after canonical results.");
    },
    revoke() {},
  } as unknown as TurnBroker;

  await expect(settleActiveCompactionSource(compactionRequest(), source, broker)).resolves.toEqual({
    answer: "Ordinary final after canonical results.",
    compactionInstructionDelivered: false,
  });
  expect(completed).toEqual([
    { callId: "call_one", result: { content: [{ type: "text", text: "one" }] } },
    { callId: "call_two", result: { content: [{ type: "text", text: "two" }] } },
  ]);
});

test("a failed exact compaction run is retryable while a successful run is replayable", async () => {
  const key = `compaction-${Date.now()}-${Math.random()}`;
  let starts = 0;
  await expect(runStructuredCompactionOnce(key, async () => {
    starts += 1;
    throw new Error("first failed");
  })).rejects.toThrow("first failed");
  await Bun.sleep(0);
  expect(existingStructuredCompactionRun(key)).toBeUndefined();
  const recovered = runStructuredCompactionOnce(key, async () => {
    starts += 1;
    return "checkpoint";
  });
  expect(runStructuredCompactionOnce(key, async () => "duplicate")).toBe(recovered);
  await expect(recovered).resolves.toBe("checkpoint");
  await expect(existingStructuredCompactionRun(key)).resolves.toBe("checkpoint");
  expect(starts).toBe(2);
});

test("retained conversation retirement preserves an already committed final response", async () => {
  const sessions = new ChatGptTurnSessions();
  const conversationKey = "a".repeat(64);
  const source = sessions.getOrCreate("source", () => ({
    mode: "read-only",
    browser: Promise.resolve("ordinary final"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey,
    cancel() {},
  }));
  await source.browserOutcome;

  await expect(sessions.retireConversationPreservingFinalResponse(
    conversationKey,
    source,
    "compacted-source",
  )).resolves.toBe(1);
  expect(sessions.find("source")).toBeUndefined();
  expect(sessions.find("compacted-source")).toBe(source);
  expect(source.conversationKey()).toBeUndefined();
});
