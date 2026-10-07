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

export interface ChatGptFinalTiming {
  status: "complete" | "retry" | "fallback" | "error";
  elapsedMs: number;
  /** Starts when the reader resolves, excluding upstream queue and transport latency. */
  readerResolvedToConsumedMs?: number;
  observations: number;
  runningObservations: number;
  toolObservations: number;
  totalObservationMs: number;
  maxObservationMs: number;
  firstStoppedMs?: number;
  lastRunningMs?: number;
}

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
  onFinalTiming?(timing: ChatGptFinalTiming): void;
  signal?: AbortSignal;
  deadline?: number;
  attempt: number;
  pollMs?: number;
  waitForPoll?(): Promise<void>;
  fallbackGraceMs?: number;
  missingResponseGraceMs?: number;
  terminalEvidenceGraceMs?: number;
  /** Inspect an empty stopped response while its output epoch is still open. */
  beforeDomFallback?(stoppedMs: number): Promise<"observe" | "terminal" | "nonterminal" | ChatGptRetryPrompt | undefined>;
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
  const poll = () => options.waitForPoll ? options.waitForPoll().then(() => ({ kind: "poll" as const })) : delay(pollMs);
  const fallbackGraceMs = options.fallbackGraceMs ?? 2_000;
  const missingResponseGraceMs = options.missingResponseGraceMs ?? 60_000;
  const terminalEvidenceGraceMs = options.terminalEvidenceGraceMs ?? 60_000;
  let sequence = options.afterSequence ?? 0;
  let readerResolvedAt: number | undefined, consumedAt: number | undefined;
  let firstStoppedAt: number | undefined, lastRunningAt: number | undefined;
  let observations = 0, runningObservations = 0, toolObservations = 0;
  let totalObservationMs = 0, maxObservationMs = 0;
  let timingStatus: ChatGptFinalTiming["status"] = "error";
  const next = () => waitForOutput(options.output, sequence, signal).then(result => {
    if (result.event.kind === "final") readerResolvedAt ??= Date.now();
    return result;
  });
  let pending = next();
  const observe = async () => {
    const startedAt = Date.now();
    const value = await options.observe();
    if (readerResolvedAt !== undefined) {
      const now = Date.now(), duration = Math.max(0, now - Math.max(startedAt, readerResolvedAt));
      observations++; totalObservationMs += duration; maxObservationMs = Math.max(maxObservationMs, duration);
      if (value.running) { runningObservations++; lastRunningAt = now; }
      if (value.toolCallsInFlight) toolObservations++;
      if (!value.running && !value.toolCallsInFlight) firstStoppedAt ??= now;
    }
    return value;
  };
  let final: BrokerTurnOutputEvent | undefined;
  let fenceRevision: number | undefined;
  let stoppedWithoutFinalSince: number | undefined;
  let missingResponseSince: number | undefined;
  let terminalEvidenceSince: number | undefined;
  let stoppedWithNativeFinalSince: number | undefined;
  let preemptiveRetry: string | undefined;
  let stopRequested = false;
  let observeImmediately = false;
  let lastHeartbeat = 0;
  const acceptOutput = (event: BrokerTurnOutputEvent): void => {
    sequence = event.sequence;
    pending = next();
    fenceRevision = undefined;
    stoppedWithoutFinalSince = undefined;
    missingResponseSince = undefined;
    terminalEvidenceSince = undefined;
    stoppedWithNativeFinalSince = undefined;
    options.onProgress?.();
    if (event.kind === "commentary") options.onCommentary?.(event.text);
    else if (event.kind === "reasoning") options.onReasoning?.(event.text);
    else { final = event; consumedAt = Date.now(); observeImmediately = true; }
  };
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      if (options.deadline !== undefined && Date.now() >= options.deadline) throw new Error("ChatGPT web turn timed out");
      if (Date.now() - lastHeartbeat >= 10_000) { options.onHeartbeat?.(); lastHeartbeat = Date.now(); }
      if (!observeImmediately) {
        const raced = await Promise.race([pending, poll()]);
        if (raced.kind === "output") {
          acceptOutput(raced.event);
          continue;
        }
      }
      observeImmediately = false;

      const observed = await observe();
      preemptiveRetry ??= options.takePreemptiveRetry?.();
      if (preemptiveRetry && observed.running && !stopRequested) {
        stopRequested = true;
        await options.stopForRetry?.();
        continue;
      }
      if (preemptiveRetry && !observed.running) {
        if (observed.toolCallsInFlight) continue;
        const settled = await Promise.race([pending, poll()]);
        if (settled.kind === "output") { acceptOutput(settled.event); continue; }
        if (final) await options.output.reset(final.sequence);
        options.completionAdmission?.reopen();
        timingStatus = "retry";
        return { status: "retry", retry: { text: preemptiveRetry }, lastSequence: sequence };
      }
      if (!final) {
        if (observed.running || observed.toolCallsInFlight) {
          stoppedWithoutFinalSince = undefined;
          missingResponseSince = undefined;
          terminalEvidenceSince = undefined;
        } else if (!observed.responsePresent) {
          stoppedWithoutFinalSince = undefined;
          terminalEvidenceSince = undefined;
          missingResponseSince ??= Date.now();
          if (Date.now() - missingResponseSince >= missingResponseGraceMs) {
            throw tunneledFallbackError(
              "ChatGPT did not create a response DOM after the message was sent",
              "chatgpt_response_dom_missing",
            );
          }
        } else {
          missingResponseSince = undefined;
          stoppedWithoutFinalSince ??= Date.now();
        }
        if (stoppedWithoutFinalSince !== undefined && Date.now() - stoppedWithoutFinalSince >= fallbackGraceMs) {
          const settled = await Promise.race([pending, poll()]);
          if (settled.kind === "output") { acceptOutput(settled.event); continue; }
          // Fence the whole confirmation, including a tool that starts and settles
          // before the DOM candidate is read. The broker checks this revision at seal.
          const sealRevision = options.completionFence ? await options.completionFence.begin() : 0;
          if (sealRevision === undefined) { stoppedWithoutFinalSince = undefined; continue; }
          const confirmed = await observe();
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
            const current = await observe();
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
            if (admission.retry === "nonterminal") {
              terminalEvidenceSince ??= Date.now();
              if (Date.now() - terminalEvidenceSince >= terminalEvidenceGraceMs) {
                throw tunneledFallbackError(
                  "ChatGPT stopped without producing terminal completion evidence",
                  "chatgpt_completion_evidence_missing",
                );
              }
              continue;
            }
            if (admission.retry === "terminal") {
              terminalEvidenceSince = undefined;
              continue;
            }
            if (admission.retry === "observe") continue;
            if (admission.retry) {
              options.completionAdmission?.reopen();
              timingStatus = "retry";
              return {
                status: "retry",
                retry: { ...admission.retry, expectedActivityRevision: sealRevision },
                lastSequence: sequence,
              };
            }
          }
          if (!await options.output.seal(sequence, sealRevision)) {
            stoppedWithoutFinalSince = undefined;
            continue;
          }
          timingStatus = "fallback";
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
        // Confirm browser state again across the broker round trip, without an
        // idle poll. Generation, tools, abort and revision races still invalidate it.
        observeImmediately = fenceRevision !== undefined;
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
        timingStatus = "retry";
        return { ...decision, lastSequence: sequence };
      }
      timingStatus = "complete";
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
    if (readerResolvedAt !== undefined && options.onFinalTiming) {
      try { options.onFinalTiming({ status: timingStatus, elapsedMs: Date.now() - readerResolvedAt,
        readerResolvedToConsumedMs: consumedAt === undefined ? undefined : consumedAt - readerResolvedAt,
        observations, runningObservations, toolObservations, totalObservationMs, maxObservationMs,
        firstStoppedMs: firstStoppedAt === undefined ? undefined : firstStoppedAt - readerResolvedAt,
        lastRunningMs: lastRunningAt === undefined ? undefined : lastRunningAt - readerResolvedAt }); }
      catch { /* Diagnostic delivery must never change completion or cleanup. */ }
    }
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
