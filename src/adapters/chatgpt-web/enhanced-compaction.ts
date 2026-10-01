import { createHash } from "node:crypto";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError } from "./adapter-error";
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
import { structuredCompactionHandoffInstruction } from "./native-compaction-control";
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
  worker: Pick<ChatGptBrowserWorker, "run">
    & Partial<Pick<ChatGptBrowserWorker, "requestPreemptiveRetry" | "armCompactionBoundaryRetention">>;
  parsed: CodexParsedRequest;
  broker: TurnBroker;
  executionNamespace: string;
  capabilities: ChatGptWebCapabilities;
  responseExecutionKey: string;
  nativeConnectorAvailable: boolean;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  requireAutomaticAdmission?: (traceId: string) => void;
  startFallback: (traceId: string, signal: AbortSignal, onProgress: () => void,
    retainOwnershipUntil: (settlement: Promise<void>) => void, controlInstruction: string) => Promise<string>;
  emit: (event: AdapterEvent) => void;
}

export async function runEnhancedCompaction(
  options: EnhancedCompactionOptions,
): Promise<"completed" | "rebuild"> {
  const {
    worker, parsed, broker, executionNamespace, capabilities, responseExecutionKey,
    nativeConnectorAvailable, abortSignal, timeoutMs, requireAutomaticAdmission, startFallback, emit,
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
    let fallbackTransaction: Awaited<ReturnType<TurnBroker["beginCompactionTransaction"]>> | undefined;
    const armDeadline = (): void => {
      if (deadline.signal.aborted) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        () => deadline.abort(new ChatGptWebAdapterError(`ChatGPT compaction did not fully settle within ${handoffTimeoutMs}ms`, { status: 409, errorType: "invalid_request_error", code: "compaction_handoff_timeout", retryable: false })),
        handoffTimeoutMs,
      );
      timer.unref?.();
      if (fallbackTransaction) {
        broker.refreshCompactionTransaction(fallbackTransaction.token, MAX_COMPACTION_HANDOFF_TIMEOUT_MS);
      }
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
      const browserAbort = new AbortController();
      const abortBrowser = () => browserAbort.abort(operationSignal.reason);
      if (operationSignal.aborted) abortBrowser();
      else operationSignal.addEventListener("abort", abortBrowser, { once: true });
      try {
        // Multipart prompt stages refresh the operation deadline, while the one-shot control token
        // cannot be reissued after it has been embedded in the final browser message.
        const pending = broker.beginCompactionTransaction(`${traceId}_fallback`, MAX_COMPACTION_HANDOFF_TIMEOUT_MS);
        void pending.then(late => {
          if (operationSignal.aborted && fallbackTransaction !== late) broker.abortCompactionTransaction(late.token);
        }, () => {});
        fallbackTransaction = await withCompactionAbort(pending, operationSignal);
        const browser = startFallback(
          `${traceId}_fallback`,
          AbortSignal.any([operationSignal, browserAbort.signal]),
          armDeadline,
          retainOwnershipUntil,
          structuredCompactionHandoffInstruction(fallbackTransaction),
        );
        const accepted = broker.waitForCompactionHandoff(fallbackTransaction.token, operationSignal);
        const browserWithoutHandoff = browser.then<never>(() => {
          throw new ChatGptWebAdapterError(
            "ChatGPT finished without sending the context summary to Codex. Check its response for a refusal or tool error.",
            { status: 409, errorType: "invalid_request_error", code: "compaction_handoff_missing", retryable: false },
          );
        });
        const raw = await withCompactionAbort(Promise.race([accepted, browserWithoutHandoff]), operationSignal);
        browserAbort.abort(new ChatGptCompactionHandoffAccepted());
        void browser.catch(() => {});
        const canonical = canonicalizeCompactionHandoff(parsed, raw);
        if (!canonical) throw new Error("ChatGPT returned an invalid structured compaction handoff");
        return canonical;
      } finally {
        if (fallbackTransaction) broker.abortCompactionTransaction(fallbackTransaction.token);
        operationSignal.removeEventListener("abort", abortBrowser);
      }
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
      let raw: string | undefined;
      if (source.isActive() && source.runtime.mode === "tools") {
        const sourceTraceId = source.traceId;
        const settled = await settleActiveCompactionSource(
          parsed,
          source,
          broker,
          operationSignal,
          handoffTimeoutMs,
          sourceTraceId && worker.armCompactionBoundaryRetention
            ? () => worker.armCompactionBoundaryRetention!(sourceTraceId)
            : undefined,
        );
        preserveFinal = !settled.compactionInstructionDelivered;
        raw = settled.handoff;
        console.info(`[chatgpt-web] active compaction result=${raw ? "checkpoint_and_response_settled" : "source_settled_without_checkpoint"}`);
      } else if (source.isActive()) {
        const outcome = await withCompactionAbort(source.browserOutcome, operationSignal);
        if (outcome.type === "error") throw outcome.error;
        await withCompactionAbort(source.physicalSettlement, operationSignal);
        preserveFinal = true;
      }
      raw ??= await requestRetainedCompactionHandoff(
        worker, parsed, source, broker, capabilities, traceId, operationSignal, handoffTimeoutMs,
        requireAutomaticAdmission, retainOwnershipUntil,
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
        return await fallback("retained_surface_unavailable");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  });
  try {
    const handoff = await withCompactionAbort(shared, abortSignal);
    console.info("[chatgpt-web] Web session mode=enhanced operation=structured_compaction result=completed");
    emit({ type: "text_delta", text: handoff, phase: "final_answer" });
    emitBrowserCompletion(
      { type: "final", answer: handoff },
      estimateChatGptWebUsage(parsed, { answer: handoff, reasoning: [] }, capabilities),
      emit,
    );
    return "completed";
  } catch (error) {
    if (abortSignal?.aborted) throw error;
    if (error instanceof ChatGptWebAdapterError
      && ["rate_limit_exceeded", "chatgpt_account_safety_stop", "chatgpt_account_safety_paused"].includes(error.code ?? "")) {
      throw error;
    }
    throw new ChatGptWebAdapterError(
      error instanceof Error ? error.message : String(error),
      {
        status: error instanceof ChatGptWebAdapterError ? error.status : 409,
        errorType: error instanceof ChatGptWebAdapterError ? error.errorType : "invalid_request_error",
        code: error instanceof ChatGptWebAdapterError ? error.code : "compaction_handoff_failed",
        retryable: false,
        cause: error,
      },
    );
  }
}
