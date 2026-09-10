import type { BrokerTurnOutputEvent, BrokerTurnOutputKind } from "./turn-broker-protocol";
import type { TurnChannel, TurnOutputWaiter } from "./turn-broker-state";

const MAX_OUTPUT_EVENT_CHARS = 1_000_000;
const MAX_OUTPUT_TOTAL_CHARS = 5_000_000;
const MAX_OUTPUT_EVENTS = 10_000;

export function submitTurnOutput(
  channel: TurnChannel,
  kind: BrokerTurnOutputKind,
  text: string,
): { event: BrokerTurnOutputEvent; duplicate: boolean } {
  assertOutputEnabled(channel);
  if (!isOutputKind(kind)) throw new Error("Codex Native output kind is invalid");
  if (!text || text.length > MAX_OUTPUT_EVENT_CHARS) throw new Error("Codex Native output text is invalid");
  if (channel.safe) throw new Error("Zero Risk requests use the safe completion contract");
  if (channel.outputSealed) throw new Error("Codex Native output arrived after DOM fallback was sealed");
  if (channel.outputFinalSequence !== undefined) {
    const final = channel.outputEvents[channel.outputFinalSequence - 1];
    if (kind === "final" && final?.text === text) return { event: final, duplicate: true };
    throw new Error(kind === "final"
      ? "Codex Native output submitted conflicting final answers"
      : "Codex Native output arrived after the final answer");
  }
  if (channel.completionCommitted) throw new Error("Codex Native output arrived after turn completion");
  if (kind === "final" && (channel.activities.size > 0 || channel.invocations.size > 0)) {
    throw new Error("Codex Native final output cannot be accepted while work tools are still active");
  }
  if (channel.outputEvents.length >= MAX_OUTPUT_EVENTS
    || channel.outputChars + text.length > MAX_OUTPUT_TOTAL_CHARS) {
    throw new Error("Codex Native output exceeds the per-turn limit");
  }
  const event = { sequence: channel.outputEvents.length + 1, kind, text } satisfies BrokerTurnOutputEvent;
  channel.outputEvents.push(event);
  channel.outputChars += text.length;
  if (kind === "final") channel.outputFinalSequence = event.sequence;
  channel.activityRevision += 1;
  resolveOutputWaiters(channel, event);
  return { event, duplicate: false };
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

export function sealTurnOutput(channel: TurnChannel, afterSequence: number): boolean {
  assertOutputEnabled(channel);
  assertSequence(afterSequence, true);
  const latest = channel.outputEvents.at(-1)?.sequence ?? 0;
  if (latest !== afterSequence) return false;
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
