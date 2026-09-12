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
import { CompactionTransactionStore } from "../src/adapters/chatgpt-web/compaction-transaction";
import { deferred } from "../src/adapters/chatgpt-web/runtime-lifecycle";

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

test("a source finishing while compact waits for ownership remains eligible for retained handoff", async () => {
  const browser = deferred<string>();
  const owner = deferred<void>();
  const source = new ChatGptTurnSession({ mode: "tools", token: Promise.resolve("source"),
    browser: browser.promise, trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {},
  });
  const previous = source.runExclusive(() => owner.promise);
  const run = settleActiveCompactionSource(compactionRequest(), source, {} as TurnBroker)
    .then(value => ({ value }), error => ({ error }));
  try {
    expect(source.isActive()).toBeTrue();
    browser.resolve("Ordinary completed answer.");
    await source.browserOutcome;
    owner.resolve();
    expect(await run).toEqual({ value: { answer: "Ordinary completed answer.", compactionInstructionDelivered: false } });
  } finally { owner.resolve(); browser.resolve("cleanup"); await previous; await run; }
});

test("active compaction preserves canonical results when the source finishes before requesting its checkpoint", async () => {
  const store = new CompactionTransactionStore();
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
    beginCompactionTransaction: async (trace: string, ttl: number) => store.begin(trace, ttl),
    waitForCompactionHandoff: (token: string, signal?: AbortSignal) => store.wait(token, signal),
    abortCompactionTransaction: (token: string) => store.abort(token),
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

test("an intercepted compact boundary supplies its checkpoint binding without preempting", async () => {
  const store = new CompactionTransactionStore();
  let finish!: (answer: string) => void;
  const browser = new Promise<string>(resolve => { finish = resolve; });
  const source = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve("turn_silent"),
    browser,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel() {},
  });
  const broker = {
    beginCompactionTransaction: async (trace: string, ttl: number) => store.begin(trace, ttl),
    waitForCompactionHandoff: (token: string, signal?: AbortSignal) => store.wait(token, signal),
    abortCompactionTransaction: (token: string) => store.abort(token),
    requestCompaction: (_token: string, result: BrokerToolResult, onDelivered?: () => void) => {
      const prompt = (result.content[0] as { text: string }).text;
      expect(prompt).toContain("do not stop first or wait for another message");
      store.submit(/turn_token (control_\w+)/.exec(prompt)![1]!, /handoff_id (handoff_\w+)/.exec(prompt)![1]!, "Valid source checkpoint.");
      onDelivered?.();
      finish("turn complete");
      return 1;
    },
    compactionDeliveryCount: () => 1,
    revoke() {},
  } as unknown as TurnBroker;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("source did not settle")), 1_000);
  try {
    await expect(settleActiveCompactionSource(
      compactionRequest(), source, broker, abort.signal,
    )).resolves.toEqual({ answer: "turn complete", compactionInstructionDelivered: true, handoff: "Valid source checkpoint." });
  } finally {
    clearTimeout(timer);
    store.close();
  }
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
