import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { runEnhancedCompaction } from "../src/adapters/chatgpt-web/enhanced-compaction";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { cancelAllStructuredCompactions, canonicalizeCompactionHandoff } from "../src/adapters/chatgpt-web/compaction-handoff";
import { requestRetainedCompactionHandoff } from "../src/adapters/chatgpt-web/retained-compaction-handoff";
import { deferred } from "../src/adapters/chatgpt-web/runtime-lifecycle";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptConversationKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import type { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { CodexParsedRequest } from "../src/types";
import type { AdapterEvent } from "../src/types";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError, chatGptRetainedSurfaceUnavailableError } from "../src/adapters/chatgpt-web/adapter-error";
import { CompactionTransactionStore } from "../src/adapters/chatgpt-web/compaction-transaction";

function fixture(active = false, tools = false) {
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
    ...(tools ? { mode: "tools" as const, token: Promise.resolve("active_source") } : { mode: "read-only" as const }),
    browser: active ? browser.promise : Promise.resolve("completed source"),
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
  return { key, source, options, release, releasing, cleanup, browser };
}

for (const stoppedWithoutHandoff of [false, true]) test(`active compact avoids preemption and reserves another message for a stopped source (missing checkpoint: ${stoppedWithoutHandoff})`, async () => {
  const f = fixture(true, true);
  const store = new CompactionTransactionStore();
  const boundary = deferred<string>();
  const events: AdapterEvent[] = [];
  let starts = 0;
  let preemptions = 0;
  let fallbackCalls = 0;
  let workerCalls = 0;
  const submit = (instruction: string) => {
    const token = /turn_token (control_\w+)/.exec(instruction)![1]!;
    const handoffId = /handoff_id (handoff_\w+)/.exec(instruction)![1]!;
    store.submit(token, handoffId, "Canonical active checkpoint.");
  };
  const broker = {
    beginCompactionTransaction: async (trace: string, ttl: number) => { starts++; return store.begin(trace, ttl); },
    waitForCompactionHandoff: (token: string, signal?: AbortSignal) => store.wait(token, signal),
    abortCompactionTransaction: (token: string) => store.abort(token),
    requestCompaction: (_token: string, result: { content: { text: string }[] }, delivered?: () => void) => {
      boundary.resolve(result.content[0]!.text); delivered?.(); return 1;
    },
    compactionDeliveryCount: () => 1, revoke() {},
  } as unknown as TurnBroker;
  const run = runEnhancedCompaction({ ...f.options, broker, timeoutMs: 2_000,
    worker: { run: async turn => {
      workerCalls++;
      expect(stoppedWithoutHandoff).toBeTrue();
      expect(f.source.isActive()).toBeFalse();
      const prepared = await turn.prepare();
      try { submit(prepared.text); return "turn complete"; } finally { prepared.release(); }
    },
      requestPreemptiveRetry: () => { preemptions++; return true; } },
    startFallback: async () => { fallbackCalls++; return "Fallback checkpoint."; },
    emit: event => { events.push(event); },
  }).then(result => ({ result }), error => ({ error }));
  try {
    const instruction = await boundary.promise;
    expect(instruction).toContain("codex.control.compaction_handoff");
    expect(preemptions).toBe(0);
    expect(f.source.runtime.compactionRequested).toBeTrue();
    if (!stoppedWithoutHandoff) submit(instruction);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(events).toEqual([]);
    expect(f.source.isActive()).toBeTrue();
    f.browser.resolve(stoppedWithoutHandoff ? "compact turn had started" : "turn complete");
    await f.releasing.promise;
    expect(events).toEqual([]);
    f.release.resolve();
    expect(await run).toEqual({ result: "completed" });
    expect(starts).toBe(stoppedWithoutHandoff ? 2 : 1);
    expect(workerCalls).toBe(stoppedWithoutHandoff ? 1 : 0);
    expect(fallbackCalls).toBe(0);
    expect(events.filter(event => event.type === "done")).toHaveLength(1);
    expect(events.filter(event => event.type === "text_delta")).toEqual([
      { type: "text_delta", phase: "final_answer", text: canonicalizeCompactionHandoff(f.options.parsed, "Canonical active checkpoint.")! },
    ]);
  } finally { store.close(); await f.cleanup(); await run; }
});

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

test("enhanced compact preserves structured account-safety failures from retained start", async () => {
  const f = fixture();
  await f.source.browserOutcome;
  f.release.resolve();
  const safetyError = new ChatGptWebAdapterError("account safety stop", {
    status: 403,
    errorType: "authentication_error",
    code: "chatgpt_account_safety_stop",
    retryable: false,
  });
  const broker = {
    beginCompactionTransaction: async () => ({ token: "control", handoffId: "handoff" }),
    waitForCompactionHandoff: async () => "unexpected handoff",
    abortCompactionTransaction() {},
  } as unknown as TurnBroker;

  try {
    const failure = await runEnhancedCompaction({
      ...f.options,
      broker,
      requireAutomaticAdmission: () => { throw safetyError; },
    }).catch(error => error);
    expect(failure).toBe(safetyError);
    expect(failure).toMatchObject({ status: 403, code: "chatgpt_account_safety_stop", retryable: false });
  } finally { await f.cleanup(); }
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

for (const surfaceLost of [false, true]) {
  test(`REG-05: retained compact ${surfaceLost ? "recovers once from surface loss" : "succeeds without fallback"}`, async () => {
    const f = fixture();
    await f.source.browserOutcome;
    f.release.resolve();
    const conversationKey = f.source.conversationKey();
    const submitted = deferred<void>();
    const events: AdapterEvent[] = [];
    const turns: BrowserTurn[] = [];
    let fallbackCalls = 0;
    let workerSettlements = 0;
    let transactionStarts = 0;
    let transactionAborts = 0;
    const summary = canonicalizeCompactionHandoff(f.options.parsed, "Canonical retained checkpoint.")!;
    const broker = {
      beginCompactionTransaction: async () => {
        transactionStarts++;
        return { token: "control", handoffId: "handoff" };
      },
      waitForCompactionHandoff: async () => { await submitted.promise; return summary; },
      abortCompactionTransaction: () => { transactionAborts++; submitted.resolve(); },
    } as unknown as TurnBroker;
    try {
      const result = await runEnhancedCompaction({ ...f.options, broker,
        worker: { run: async turn => {
          turns.push(turn);
          try {
            if (surfaceLost) throw chatGptRetainedSurfaceUnavailableError(new Error("fixture surface loss"));
            const prepared = await turn.prepare();
            try {
              expect(prepared.text).toContain("codex.control.compaction_handoff");
              submitted.resolve();
              expect(turn.abortSignal!.aborted).toBeFalse();
              return "turn complete";
            } finally { prepared.release(); }
          } finally { workerSettlements++; }
        } },
        startFallback: async traceId => {
          fallbackCalls++;
          expect(traceId).toEndWith("_fallback");
          expect(workerSettlements).toBe(1);
          expect(f.source.conversationKey()).toBeUndefined();
          return summary;
        },
        emit: event => { events.push(event); },
      });
      expect(result).toBe("completed");
      expect(fallbackCalls).toBe(surfaceLost ? 1 : 0);
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({ conversationKey, requireRetainedConversation: true, nativeConnector: true });
      expect(workerSettlements).toBe(1);
      expect(transactionStarts).toBe(1);
      expect(transactionAborts).toBe(1);
      expect(events.filter(event => event.type === "text_delta")).toEqual([
        { type: "text_delta", text: summary, phase: "final_answer" },
      ]);
      expect(events.filter(event => event.type === "done")).toHaveLength(1);
      expect(f.source.conversationKey()).toBeUndefined();
      expect(f.source.isActive()).toBeFalse();
    } finally { submitted.resolve(); await f.cleanup(); }
  });
}
