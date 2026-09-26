import { ChatGptWebAdapterError } from "./adapter-error";
import { ChatGptFinalAnswerDecisionError, decideChatGptFinalAnswer } from "./final-answer-gate";
import type { ChatGptRetryPrompt } from "./steering";
import type { BrokerTurnOutputEvent } from "./turn-broker-protocol";

export interface ChatGptTunneledOutputReader {
  next(afterSequence: number, signal?: AbortSignal): Promise<BrokerTurnOutputEvent>;
  reset(finalSequence: number): Promise<void>;
  seal(afterSequence: number, expectedRevision: number): Promise<boolean>;
}

interface TunnelObservation { running: boolean; responsePresent: boolean; toolCallsInFlight?: boolean }

interface TunnelOptions {
  output: ChatGptTunneledOutputReader;
  afterSequence?: number;
  observe(): Promise<TunnelObservation>;
  completionFence?: { begin(): Promise<number | undefined>; commit(revision: number): Promise<boolean> };
  completionAdmission?: { seal(): boolean; reopen(): void };
  retryPromptForAnswer?: (answer: string, attempt: number) => string | ChatGptRetryPrompt | undefined | Promise<string | ChatGptRetryPrompt | undefined>;
  takePreemptiveRetry?(): string | undefined;
  stopForRetry?(): Promise<void>;
  onCommentary?(text: string): void;
  onReasoning?(text: string): void;
  onFinal(text: string): void;
  onHeartbeat?(): void;
  onProgress?(): void;
  signal?: AbortSignal;
  deadline?: number;
  attempt: number;
  pollMs?: number;
  fallbackGraceMs?: number;
  /** Inspect an empty stopped response while its output epoch is still open. */
  beforeDomFallback?(stoppedMs: number): Promise<"observe" | ChatGptRetryPrompt | undefined>;
}

export type ChatGptTunneledOutputDecision =
  | { status: "complete"; answer: string }
  | { status: "retry"; retry: ChatGptRetryPrompt; lastSequence: number }
  | { status: "fallback"; lastSequence: number };

/** Consume private Native2 output while the browser is used only as the completion authority. */
export async function runChatGptTunneledOutputTurn(options: TunnelOptions): Promise<ChatGptTunneledOutputDecision> {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const pollMs = options.pollMs ?? 250;
  const fallbackGraceMs = options.fallbackGraceMs ?? 2_000;
  let sequence = options.afterSequence ?? 0;
  let pending = waitForOutput(options.output, sequence, signal);
  let final: BrokerTurnOutputEvent | undefined;
  let fenceRevision: number | undefined;
  let stoppedWithoutFinalSince: number | undefined;
  let stoppedWithNativeFinalSince: number | undefined;
  let preemptiveRetry: string | undefined;
  let stopRequested = false;
  let lastHeartbeat = 0;
  const acceptOutput = (event: BrokerTurnOutputEvent): void => {
    sequence = event.sequence;
    pending = waitForOutput(options.output, sequence, signal);
    fenceRevision = undefined;
    stoppedWithoutFinalSince = undefined;
    stoppedWithNativeFinalSince = undefined;
    options.onProgress?.();
    if (event.kind === "commentary") options.onCommentary?.(event.text);
    else if (event.kind === "reasoning") options.onReasoning?.(event.text);
    else final = event;
  };
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      if (options.deadline !== undefined && Date.now() >= options.deadline) throw new Error("ChatGPT web turn timed out");
      if (Date.now() - lastHeartbeat >= 10_000) { options.onHeartbeat?.(); lastHeartbeat = Date.now(); }
      const raced = await Promise.race([pending, delay(pollMs)]);
      if (raced.kind === "output") {
        acceptOutput(raced.event);
        continue;
      }

      const observed = await options.observe();
      preemptiveRetry ??= options.takePreemptiveRetry?.();
      if (preemptiveRetry && observed.running && !stopRequested) {
        stopRequested = true;
        await options.stopForRetry?.();
        continue;
      }
      if (preemptiveRetry && !observed.running) {
        if (observed.toolCallsInFlight) continue;
        const settled = await Promise.race([pending, delay(pollMs)]);
        if (settled.kind === "output") { acceptOutput(settled.event); continue; }
        if (final) await options.output.reset(final.sequence);
        options.completionAdmission?.reopen();
        return { status: "retry", retry: { text: preemptiveRetry }, lastSequence: sequence };
      }
      if (!final) {
        if (!observed.responsePresent || observed.running || observed.toolCallsInFlight) stoppedWithoutFinalSince = undefined;
        else stoppedWithoutFinalSince ??= Date.now();
        if (stoppedWithoutFinalSince !== undefined && Date.now() - stoppedWithoutFinalSince >= fallbackGraceMs) {
          const settled = await Promise.race([pending, delay(pollMs)]);
          if (settled.kind === "output") { acceptOutput(settled.event); continue; }
          // Fence the whole confirmation, including a tool that starts and settles
          // before the DOM candidate is read. The broker checks this revision at seal.
          const sealRevision = options.completionFence ? await options.completionFence.begin() : 0;
          if (sealRevision === undefined) { stoppedWithoutFinalSince = undefined; continue; }
          const confirmed = await options.observe();
          if (!confirmed.responsePresent || confirmed.running || confirmed.toolCallsInFlight) {
            stoppedWithoutFinalSince = undefined;
            continue;
          }
          const finalCheck = await Promise.race([pending, delay(0)]);
          if (finalCheck.kind === "output") { acceptOutput(finalCheck.event); continue; }
          if (options.beforeDomFallback) {
            const admission = await options.beforeDomFallback(Date.now() - stoppedWithoutFinalSince)
              .then(retry => ({ retry }), error => ({ error }));
            // Native output, resumed work and cancellation take precedence over a recovery decision.
            const current = await options.observe();
            const arrived = await Promise.race([pending, delay(0)]);
            options.signal?.throwIfAborted();
            if (arrived.kind === "output") { acceptOutput(arrived.event); continue; }
            if (!current.responsePresent || current.running || current.toolCallsInFlight) {
              stoppedWithoutFinalSince = undefined;
              continue;
            }
            preemptiveRetry ??= options.takePreemptiveRetry?.();
            if (preemptiveRetry) continue;
            if ("error" in admission) throw admission.error;
            if (admission.retry === "observe") continue;
            if (admission.retry) {
              options.completionAdmission?.reopen();
              return { status: "retry", retry: admission.retry, lastSequence: sequence };
            }
          }
          if (!await options.output.seal(sequence, sealRevision)) {
            stoppedWithoutFinalSince = undefined;
            continue;
          }
          return { status: "fallback", lastSequence: sequence };
        }
        continue;
      }
      if (observed.running || observed.toolCallsInFlight) {
        stoppedWithNativeFinalSince = undefined;
        fenceRevision = undefined;
        continue;
      }
      // A Native2 final is the answer authority. Some Web surfaces never project an
      // assistant turn after tool work, so require a stopped, settled interval instead.
      if (!observed.responsePresent) {
        stoppedWithNativeFinalSince ??= Date.now();
        if (Date.now() - stoppedWithNativeFinalSince < fallbackGraceMs) continue;
      }
      if (options.completionFence && fenceRevision === undefined) {
        fenceRevision = await options.completionFence.begin();
        continue;
      }
      const decision = await decideChatGptFinalAnswer({
        answer: final.text,
        attempt: options.attempt,
        retryPromptForAnswer: options.retryPromptForAnswer,
        completionFence: options.completionFence,
        completionFenceRevision: fenceRevision,
        completionAdmission: options.completionAdmission,
        abortSignal: options.signal,
        finalizeAnswer: () => { options.onFinal(final!.text); return final!.text; },
      });
      if (decision.status === "observe") { fenceRevision = undefined; continue; }
      if (decision.status === "retry") {
        await options.output.reset(final.sequence);
        return { ...decision, lastSequence: sequence };
      }
      return decision;
    }
  } catch (error) {
    if (error instanceof ChatGptFinalAnswerDecisionError) {
      if (!error.completionCommitted) options.completionAdmission?.reopen();
      throw error.original;
    }
    options.completionAdmission?.reopen();
    throw error;
  } finally {
    controller.abort();
    void pending.catch(() => {});
  }
}

export function decideTunneledDomFallbackFinal(
  options: Parameters<typeof decideChatGptFinalAnswer>[0],
): ReturnType<typeof decideChatGptFinalAnswer> {
  const retryPromptForAnswer = options.retryPromptForAnswer;
  return decideChatGptFinalAnswer({
    ...options,
    emptyAnswerError: () => tunneledFallbackError(
      "ChatGPT tunneled output fallback completed without a user-facing final answer",
      "chatgpt_completion_evidence_missing",
    ),
    retryPromptForAnswer: retryPromptForAnswer ? async (answer, attempt) => {
      if (await retryPromptForAnswer(answer, attempt) === undefined) return undefined;
      throw tunneledFallbackError(
        "ChatGPT tunneled output fallback cannot safely complete while a same-surface retry is pending",
        "chatgpt_tunneled_fallback_retry_required",
      );
    } : undefined,
  });
}

function tunneledFallbackError(message: string, code: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(message, {
    status: 502,
    errorType: "server_error",
    code,
    retryable: false,
    retireSession: true,
  });
}

function waitForOutput(output: ChatGptTunneledOutputReader, sequence: number, signal: AbortSignal) {
  return output.next(sequence, signal).then(event => ({ kind: "output" as const, event }));
}

function delay(ms: number): Promise<{ kind: "poll" }> {
  return new Promise(resolve => setTimeout(() => resolve({ kind: "poll" }), ms));
}
