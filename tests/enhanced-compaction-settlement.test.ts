import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { runEnhancedCompaction } from "../src/adapters/chatgpt-web/enhanced-compaction";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { cancelAllStructuredCompactions } from "../src/adapters/chatgpt-web/compaction-handoff";
import { requestRetainedCompactionHandoff } from "../src/adapters/chatgpt-web/retained-compaction-handoff";
import { deferred } from "../src/adapters/chatgpt-web/runtime-lifecycle";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptConversationKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import type { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { CodexParsedRequest } from "../src/types";

function fixture(active = false) {
  const key = randomUUID();
  const browser = deferred<string>();
  const release = deferred<void>();
  const releasing = deferred<void>();
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID, stream: true, options: { reasoning: "medium" }, _compactionRequest: true,
    context: { messages: [{ role: "user", content: "Inspect the project", timestamp: 1 }] },
    _rawBody: { prompt_cache_key: key,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: key, turn_id: "compact-turn" }) },
      input: [{ type: "message", role: "user",
      content: [{ type: "input_text", text: "Inspect the project" }],
      internal_chat_message_metadata_passthrough: { turn_id: "source-turn" } }] },
  };
  const source = chatGptTurnSessions.getOrCreate(key, () => ({
    mode: "read-only", browser: active ? browser.promise : Promise.resolve("completed source"),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), conversationKey: chatGptConversationKey(parsed, key),
    usageInput: parsed, cancel: () => browser.resolve("cancelled"),
    release: async () => { releasing.resolve(); await release.promise; },
  }));
  const options = {
    worker: { run: async () => { throw new Error("unexpected handoff surface"); } },
    parsed, broker: {} as TurnBroker, executionNamespace: key,
    capabilities: { localToolsEnabled: true, solAvailable: true, proAvailable: true },
    responseExecutionKey: key, nativeConnectorAvailable: true,
    startFallback: async () => "Checkpoint summary.", emit: () => {},
  };
  const cleanup = async () => { release.resolve(); browser.resolve("cleanup"); await chatGptTurnSessions.retireAndWait(key); };
  return { key, source, options, release, releasing, cleanup };
}

for (const sameExecutionKey of [true, false]) test(`enhanced compact waits for detached source release (same key: ${sameExecutionKey})`, async () => {
  const f = fixture();
  await f.source.browserOutcome;
  const retirement = chatGptTurnSessions.retireAndWait(f.key);
  await f.releasing.promise;
  let fallbackStarted = false;
  const run = runEnhancedCompaction({ ...f.options,
    responseExecutionKey: sameExecutionKey ? f.key : `${f.key}:next`, startFallback: async () => {
    fallbackStarted = true; return "Checkpoint summary.";
  } });
  try {
    await Bun.sleep(0);
    expect(fallbackStarted).toBe(false);
    f.release.resolve();
    await retirement;
    await expect(run).resolves.toBe("completed");
    expect(fallbackStarted).toBe(true);
  } finally { await f.cleanup(); await run.catch(() => {}); }
});

test("compact cleanup failure preserves both the handoff error and retirement cause", async () => {
  const f = fixture(true);
  const run = runEnhancedCompaction(f.options).catch(error => error);
  await Bun.sleep(0);
  const cancel = cancelAllStructuredCompactions(new Error("operator cancelled"));
  await f.releasing.promise;
  f.release.reject(new Error("release fixture failed"));
  await cancel;
  const failure = await run;
  expect(failure.code).toBe("compaction_handoff_failed");
  expect(failure.cause).toBeInstanceOf(AggregateError);
  expect(failure.cause.errors.map((error: Error) => error.message)).toEqual(["operator cancelled", "release fixture failed"]);
  await f.cleanup();
});

test("operator compact cancellation waits for physical source release", async () => {
  const f = fixture(true);
  const run = runEnhancedCompaction(f.options).catch(error => error);
  await Bun.sleep(0);
  let acknowledged = false;
  const cancel = cancelAllStructuredCompactions(new Error("operator cancelled"))
    .then(count => { acknowledged = true; return count; });
  try {
    await f.releasing.promise;
    await Bun.sleep(0);
    expect(acknowledged).toBe(false);
    f.release.resolve();
    expect(await cancel).toBe(1);
    expect((await run).message).toContain("operator cancelled");
  } finally { await f.cleanup(); await cancel; await run; }
});

test("operator cancellation during source lookup does not start a fallback", async () => {
  const f = fixture();
  await f.cleanup();
  let fallbackCalls = 0;
  const run = runEnhancedCompaction({ ...f.options, startFallback: async () => {
    fallbackCalls++; return "Checkpoint summary.";
  } }).catch(error => error);
  await Promise.resolve();
  await cancelAllStructuredCompactions(new Error("operator cancelled"));
  expect((await run).message).toContain("operator cancelled");
  expect(fallbackCalls).toBe(0);
});

test("retained handoff cancellation waits for the handoff worker to settle", async () => {
  const f = fixture();
  const entered = deferred<void>();
  const stopped = deferred<void>();
  const physical = deferred<string>();
  const abort = new AbortController();
  const broker = {
    beginCompactionTransaction: async () => ({ token: "fixture", handoffId: "fixture" }),
    waitForCompactionHandoff: () => new Promise<string>(() => {}),
    abortCompactionTransaction() {},
  } as unknown as TurnBroker;
  let settled = false;
  const run = requestRetainedCompactionHandoff({ run: turn => {
    turn.abortSignal!.addEventListener("abort", () => stopped.resolve(), { once: true });
    entered.resolve(); return physical.promise;
  } }, f.options.parsed, f.source, broker, f.options.capabilities, "fixture-trace", abort.signal)
    .catch(error => error).finally(() => { settled = true; });
  try {
    await entered.promise;
    abort.abort(new Error("operator cancelled"));
    await stopped.promise;
    await Bun.sleep(0);
    expect(settled).toBe(false);
    physical.resolve("stopped");
    expect((await run).message).toContain("operator cancelled");
  } finally { physical.resolve("cleanup"); await run; await f.cleanup(); }
});
