export interface PreemptiveRetryStopState {
  deadline: number;
  stopPressed: boolean;
}

export type PreemptiveRetryStopAction = "proceed" | "press_stop" | "wait" | "timed_out";

export function beginPreemptiveRetryStop(now: number, timeoutMs: number): PreemptiveRetryStopState {
  if (!Number.isFinite(now) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("preemptive retry stop timing must be finite and positive");
  }
  return { deadline: now + timeoutMs, stopPressed: false };
}

export function advancePreemptiveRetryStop(
  state: PreemptiveRetryStopState,
  running: boolean,
  now: number,
): { state: PreemptiveRetryStopState; action: PreemptiveRetryStopAction } {
  if (!running) return { state, action: "proceed" };
  if (now >= state.deadline) return { state, action: "timed_out" };
  if (state.stopPressed) return { state, action: "wait" };
  return { state: { ...state, stopPressed: true }, action: "press_stop" };
}
