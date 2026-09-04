import type { AdapterEvent, CodexParsedRequest } from "../../types";
import { ChatGptWebAdapterError } from "./adapter-error";
import { MAX_COMPACTION_HANDOFF_TIMEOUT_MS, runStructuredCompactionOnce, withCompactionAbort } from "./compaction-handoff";
import type { ChatGptWebCapabilities } from "./model";
import { chatGptTurnSessions, type ChatGptTurnSession } from "./turn-execution";
import { emitBrowserCompletion } from "./turn-events";
import { estimateChatGptWebUsage } from "./usage";

/** A native disconnect detaches its observer, not the user-operated checkpoint. */
export async function runManualCompaction(options: {
  parsed: CodexParsedRequest;
  executionKey: string;
  sourceKey: string;
  traceId: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  capabilities: ChatGptWebCapabilities;
  start: (signal: AbortSignal) => Promise<ChatGptTurnSession>;
  emit: (event: AdapterEvent) => void;
}): Promise<void> {
  options.abortSignal?.throwIfAborted();
  const shared = runStructuredCompactionOnce(options.executionKey, {
    ownerKey: options.sourceKey, traceIds: [options.traceId],
  }, async operatorSignal => {
    const timeoutMs = Math.min(options.timeoutMs ?? MAX_COMPACTION_HANDOFF_TIMEOUT_MS, MAX_COMPACTION_HANDOFF_TIMEOUT_MS);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error(`ChatGPT compaction did not fully settle within ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    const signal = AbortSignal.any([operatorSignal, deadline.signal]);
    let session: ChatGptTurnSession | undefined;
    try {
      // Physical retirement must finish even when the deadline expires during cleanup.
      await chatGptTurnSessions.retireAndWait(options.sourceKey);
      signal.throwIfAborted();
      session = await options.start(signal);
      if (session.runtime.mode === "tools") void session.runtime.token.catch(() => {});
      const outcome = await withCompactionAbort(session.browserOutcome, signal);
      if (outcome.type === "error") throw outcome.error;
      await withCompactionAbort(session.physicalSettlement, signal);
      return outcome.answer;
    } finally {
      try {
        if (session) await chatGptTurnSessions.retireAndWait(options.executionKey);
      } finally { clearTimeout(timer); }
    }
  });
  let answer: string;
  try {
    answer = await withCompactionAbort(shared, options.abortSignal);
  } catch (error) {
    if (!(error instanceof ChatGptWebAdapterError)) throw error;
    options.emit({ type: "error", message: error.message, status: error.status,
      errorType: error.errorType, code: error.code, retryable: error.retryable });
    return;
  }
  options.emit({ type: "text_delta", text: answer, phase: "final_answer" });
  emitBrowserCompletion({ type: "final", answer },
    estimateChatGptWebUsage(options.parsed, { answer, reasoning: [] }, options.capabilities), options.emit);
}
