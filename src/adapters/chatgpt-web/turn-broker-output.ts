import type { BrokerTurnOutputEvent, BrokerTurnOutputKind } from "./turn-broker-protocol";
import type { TurnChannel, TurnOutputWaiter } from "./turn-broker-state";
import { ChatGptToolEvidenceGuard } from "./tool-evidence-guard";

const MAX_OUTPUT_EVENT_CHARS = 1_000_000;
const MAX_OUTPUT_TOTAL_CHARS = 5_000_000;
const MAX_OUTPUT_EVENTS = 10_000;

export function submitTurnOutput(
  channel: TurnChannel,
  kind: BrokerTurnOutputKind,
  text: string,
  nextMessagePrediction?: string | null,
): { event: BrokerTurnOutputEvent; duplicate: boolean } {
  assertOutputEnabled(channel);
  if (nextMessagePrediction !== undefined) {
    if (kind !== "final") throw new Error("Codex Native prediction is only valid on final output");
    if (!channel.predictionEnabled) throw new Error("Codex Native prediction is not enabled for this turn");
    if (nextMessagePrediction !== null && (typeof nextMessagePrediction !== "string"
      || nextMessagePrediction.length > 2_000)) throw new Error("Codex Native prediction is invalid");
  }
  if (!isOutputKind(kind)) throw new Error("Codex Native output kind is invalid");
  if (!text || (kind === "final" && !text.trim()) || text.length > MAX_OUTPUT_EVENT_CHARS) {
    throw new Error("Codex Native output text is invalid");
  }
  if (channel.safe) throw new Error("Zero Risk requests use the safe completion contract");
  if (channel.outputSealed) throw new Error("Codex Native output arrived after DOM fallback was sealed");
  if (channel.finalizationOnly && !channel.finalizationOutputArmed) {
    if (kind !== "final") {
      throw new Error("Codex Native non-final output arrived while browser recovery submission was pending");
    }
    const pending = channel.finalizationPendingOutput;
    if (pending) {
      if (pending.text === text && pending.nextMessagePrediction === nextMessagePrediction) return { event: pending, duplicate: true };
      throw new Error("Codex Native output submitted conflicting final answers");
    }
    if (channel.completionCommitted || channel.activities.size > 0 || channel.invocations.size > 0) {
      throw new Error("Codex Native final output cannot be accepted while work tools are still active");
    }
    if (channel.outputEvents.length >= MAX_OUTPUT_EVENTS
      || channel.outputChars + text.length + (nextMessagePrediction?.length ?? 0) > MAX_OUTPUT_TOTAL_CHARS) {
      throw new Error("Codex Native output exceeds the per-turn limit");
    }
    (channel.toolEvidence ??= new ChatGptToolEvidenceGuard()).assertSupportedOutput(text);
    const event = { sequence: channel.outputEvents.length + 1, kind, text,
      ...(nextMessagePrediction === undefined ? {} : { nextMessagePrediction }) } satisfies BrokerTurnOutputEvent;
    channel.finalizationPendingOutput = event;
    return { event, duplicate: false };
  }
  if (channel.outputFinalSequence !== undefined) {
    const final = channel.outputEvents[channel.outputFinalSequence - 1];
    if (kind === "final" && final?.text === text && final.nextMessagePrediction === nextMessagePrediction) return { event: final, duplicate: true };
    throw new Error(kind === "final"
      ? "Codex Native output submitted conflicting final answers"
      : "Codex Native output arrived after the final answer");
  }
  if (channel.completionCommitted) throw new Error("Codex Native output arrived after turn completion");
  if (kind === "final" && (channel.activities.size > 0 || channel.invocations.size > 0)) {
    throw new Error("Codex Native final output cannot be accepted while work tools are still active");
  }
  if (channel.outputEvents.length >= MAX_OUTPUT_EVENTS
    || channel.outputChars + text.length + (nextMessagePrediction?.length ?? 0) > MAX_OUTPUT_TOTAL_CHARS) {
    throw new Error("Codex Native output exceeds the per-turn limit");
  }
  if (kind !== "reasoning") (channel.toolEvidence ??= new ChatGptToolEvidenceGuard()).assertSupportedOutput(text);
  const event = { sequence: channel.outputEvents.length + 1, kind, text,
    ...(nextMessagePrediction === undefined ? {} : { nextMessagePrediction }) } satisfies BrokerTurnOutputEvent;
  publishTurnOutput(channel, event);
  return { event, duplicate: false };
}

/** Publish a final held across the recovery click/IPC acknowledgement window. */
export function publishPendingFinalizationOutput(channel: TurnChannel): void {
  const event = channel.finalizationPendingOutput;
  if (!event) return;
  channel.finalizationPendingOutput = undefined;
  publishTurnOutput(channel, event);
}

function publishTurnOutput(channel: TurnChannel, event: BrokerTurnOutputEvent): void {
  channel.outputEvents.push(event);
  channel.outputChars += event.text.length + (event.nextMessagePrediction?.length ?? 0);
  if (event.kind === "final") channel.outputFinalSequence = event.sequence;
  channel.activityRevision += 1;
  resolveOutputWaiters(channel, event);
}

export function waitForTurnOutput(
  channel: TurnChannel,
  afterSequence: number,
  signal?: AbortSignal,
): Promise<BrokerTurnOutputEvent> {
  assertOutputEnabled(channel);
  assertSequence(afterSequence, true);
  const effectiveAfter = Math.max(afterSequence, channel.outputResumeAfter);
  const ready = channel.outputEvents.find(event => event.sequence > effectiveAfter);
  if (ready) return Promise.resolve(ready);
  if (signal?.aborted) return Promise.reject(new DOMException("turn output wait aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const waiter: TurnOutputWaiter = { afterSequence: effectiveAfter, resolve, reject, ...(signal ? { signal } : {}) };
    if (signal) {
      waiter.onAbort = () => {
        channel.outputWaiters.delete(waiter);
        reject(new DOMException("turn output wait aborted", "AbortError"));
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    channel.outputWaiters.add(waiter);
  });
}

export function resetTurnOutput(channel: TurnChannel, finalSequence: number): void {
  assertOutputEnabled(channel);
  assertSequence(finalSequence, false);
  if (channel.outputFinalSequence !== finalSequence) {
    throw new Error("Codex Native output reset does not match the pending final answer");
  }
  channel.outputFinalSequence = undefined;
  channel.outputResumeAfter = finalSequence;
  channel.activityRevision += 1;
}

export function sealTurnOutput(channel: TurnChannel, afterSequence: number, expectedRevision: number): boolean {
  assertOutputEnabled(channel);
  assertSequence(afterSequence, true);
  assertSequence(expectedRevision, true);
  const latest = channel.outputEvents.at(-1)?.sequence ?? 0;
  if (latest !== afterSequence) return false;
  if (channel.activityRevision !== expectedRevision || channel.activities.size > 0 || channel.invocations.size > 0) return false;
  channel.outputSealed = true;
  channel.activityRevision += 1;
  return true;
}

export function rejectTurnOutputWaiters(channel: TurnChannel, error: Error): void {
  for (const waiter of channel.outputWaiters) {
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.reject(error);
  }
  channel.outputWaiters.clear();
}

function resolveOutputWaiters(channel: TurnChannel, event: BrokerTurnOutputEvent): void {
  for (const waiter of [...channel.outputWaiters]) {
    if (event.sequence <= waiter.afterSequence) continue;
    channel.outputWaiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(event);
  }
}

function isOutputKind(value: unknown): value is BrokerTurnOutputKind {
  return value === "commentary" || value === "reasoning" || value === "final";
}

function assertSequence(value: number, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error("Codex Native output sequence is invalid");
  }
}

function assertOutputEnabled(channel: TurnChannel): void {
  if (!channel.outputEnabled) throw new Error("Codex Native output tunnel is not enabled for this turn");
}
