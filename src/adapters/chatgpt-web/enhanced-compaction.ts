import { createHash } from "node:crypto";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import { ChatGptWebAdapterError } from "./adapter-error";
import type { ChatGptBrowserWorker } from "./browser-worker";
import {
  canonicalizeCompactionHandoff,
  existingStructuredCompactionRun,
  MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  runStructuredCompactionOnce,
  settleActiveCompactionSource,
  withCompactionAbort,
} from "./compaction-handoff";
import type { ChatGptWebCapabilities } from "./model";
import {
  requestRetainedCompactionHandoff,
  RetainedCompactionSourceUnavailableError,
} from "./retained-compaction-handoff";
import type { TurnBroker } from "./turn-broker";
import { chatGptConversationKey, chatGptTurnExecutionKey, chatGptTurnSessions, type ChatGptTurnSession } from "./turn-execution";
import { emitBrowserCompletion } from "./turn-events";
import { estimateChatGptWebUsage } from "./usage";
import { extractChatGptTurnIdentity } from "./environment";

interface EnhancedCompactionOptions {
  worker: Pick<ChatGptBrowserWorker, "run">;
  parsed: CodexParsedRequest;
  broker: TurnBroker;
  executionNamespace: string;
  capabilities: ChatGptWebCapabilities;
  responseExecutionKey: string;
  nativeConnectorAvailable: boolean;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  startFallback: (traceId: string, signal: AbortSignal, onProgress: () => void, retainOwnershipUntil: (settlement: Promise<void>) => void) => Promise<string>;
  emit: (event: AdapterEvent) => void;
}

export async function runEnhancedCompaction(
  options: EnhancedCompactionOptions,
): Promise<"completed" | "rebuild"> {
  const {
    worker, parsed, broker, executionNamespace, capabilities, responseExecutionKey,
    nativeConnectorAvailable, abortSignal, timeoutMs, startFallback, emit,
  } = options;
  if (!nativeConnectorAvailable) {
    throw new ChatGptWebAdapterError(
      "Enhanced Web structured compaction requires the Codex Native2 connector.",
      {
        status: 409,
        errorType: "invalid_request_error",
        code: "compaction_handoff_unavailable",
        retryable: false,
      },
    );
  }
  const compactionExecutionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
  const traceId = createHash("sha256")
    .update(`${compactionExecutionKey}:handoff`)
    .digest("hex")
    .slice(0, 12);
  let shared = existingStructuredCompactionRun(compactionExecutionKey);
  const identity = extractChatGptTurnIdentity(parsed);
  if (!shared) shared = runStructuredCompactionOnce(compactionExecutionKey, {
    ownerKey: responseExecutionKey,
    traceIds: [traceId, `${traceId}_fallback`],
    nativeThreadId: identity.threadId, nativeTurnId: identity.turnId,
  }, async (operatorSignal, retainOwnershipUntil) => {
    const handoffTimeoutMs = Math.min(
      timeoutMs ?? MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
      MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
    );
    const deadline = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armDeadline = (): void => {
      if (deadline.signal.aborted) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        () => deadline.abort(new Error(`ChatGPT compaction did not fully settle within ${handoffTimeoutMs}ms`)),
        handoffTimeoutMs,
      );
      timer.unref?.();
    };
    armDeadline();
    const operationSignal = AbortSignal.any([deadline.signal, operatorSignal]);
    let source: ChatGptTurnSession | undefined;
    let preserveFinal = false;
    const sourceConversationKey = chatGptConversationKey(parsed, executionNamespace);
    const fallback = async (reason: string): Promise<string> => {
      operationSignal.throwIfAborted();
      console.warn(`[chatgpt-web] retained compaction fallback=${reason}`);
      armDeadline();
      const raw = await startFallback(`${traceId}_fallback`, operationSignal, armDeadline, retainOwnershipUntil);
      const canonical = canonicalizeCompactionHandoff(parsed, raw);
      if (!canonical) throw new Error("ChatGPT returned an invalid structured compaction handoff");
      return canonical;
    };
    try {
      await chatGptTurnSessions.waitForRetirement(responseExecutionKey, operationSignal);
      if (sourceConversationKey) await chatGptTurnSessions.waitForConversationRetirement(sourceConversationKey, operationSignal);
      source = chatGptTurnSessions.find(responseExecutionKey);
      preserveFinal = !source?.isActive() && source?.settledOutcome()?.type === "final";
      const conversationKey = source?.conversationKey();
      if (!source || !conversationKey) {
        if (source) await withCompactionAbort(
          chatGptTurnSessions.retireAndWait(responseExecutionKey), operationSignal,
        );
        return await fallback("source_unavailable_before_handoff");
      }
      if (source.isActive() && source.runtime.mode === "tools") {
        const settled = await settleActiveCompactionSource(parsed, source, broker, operationSignal);
        preserveFinal = !settled.compactionInstructionDelivered;
      } else if (source.isActive()) {
        const outcome = await withCompactionAbort(source.browserOutcome, operationSignal);
        if (outcome.type === "error") throw outcome.error;
        await withCompactionAbort(source.physicalSettlement, operationSignal);
        preserveFinal = true;
      }
      const raw = await requestRetainedCompactionHandoff(
        worker, parsed, source, broker, capabilities, traceId, operationSignal, handoffTimeoutMs,
      );
      const canonical = canonicalizeCompactionHandoff(parsed, raw);
      if (!canonical) throw new Error("ChatGPT returned an invalid structured compaction handoff");
      await withCompactionAbort(
        preserveFinal
          ? chatGptTurnSessions.retireConversationPreservingFinalResponse(
              conversationKey, source, responseExecutionKey,
            )
          : chatGptTurnSessions.retireConversationAndWait(conversationKey),
        operationSignal,
      );
      return canonical;
    } catch (error) {
      const conversationKey = source?.conversationKey();
      try {
        if (source && conversationKey) {
          await (preserveFinal
            ? chatGptTurnSessions.retireConversationPreservingFinalResponse(
                conversationKey, source, responseExecutionKey,
              )
            : chatGptTurnSessions.retireConversationAndWait(conversationKey));
        }
        // A successful handoff can detach the source before cancellation reaches this catch.
        await chatGptTurnSessions.waitForRetirement(responseExecutionKey);
        if (sourceConversationKey) await chatGptTurnSessions.waitForConversationRetirement(sourceConversationKey);
      } catch (retirementError) {
        throw new AggregateError([error, retirementError], "Structured compaction failed and its retained conversation could not be retired");
      }
      operationSignal.throwIfAborted();
      if (error instanceof RetainedCompactionSourceUnavailableError) {
        return await fallback("source_disappeared_before_handoff");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  });
  try {
    const handoff = await withCompactionAbort(shared, abortSignal);
    console.info("[chatgpt-web] Web session mode=enhanced path=active_handoff result=completed");
    emit({ type: "text_delta", text: handoff, phase: "final_answer" });
    emitBrowserCompletion(
      { type: "final", answer: handoff },
      estimateChatGptWebUsage(parsed, { answer: handoff, reasoning: [] }, capabilities),
      emit,
    );
    return "completed";
  } catch (error) {
    if (abortSignal?.aborted) throw error;
    throw new ChatGptWebAdapterError(
      error instanceof Error ? error.message : String(error),
      { status: 409, errorType: "invalid_request_error", code: "compaction_handoff_failed", retryable: false, cause: error },
    );
  }
}
