import type { SafeTurnControl, SafeWaiter, TurnChannel } from "./turn-broker-state";

export function assertSurfaceNonce(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{20,256}$/.test(value)) {
    throw new Error("Zero Risk local browser binding is invalid");
  }
}

export function createSafeTurn(surfaceNonce: string): SafeTurnControl {
  assertSurfaceNonce(surfaceNonce);
  return {
    state: "awaiting_start",
    surfaceNonce,
    launcherSent: false,
    connectorStarted: false,
    sentWaiters: new Set(),
    startWaiters: new Set(),
    completionWaiters: new Set(),
  };
}

export function requireSafeTurn(channel: TurnChannel | undefined): SafeTurnControl {
  if (!channel) throw new Error("Zero Risk request_id is invalid, expired, or revoked");
  if (!channel.safe) throw new Error("request_id is not registered for Zero Risk browser interaction");
  return channel.safe;
}

export function startSafeTurn(channel: TurnChannel | undefined): { started: true; duplicate: boolean } {
  const safe = requireSafeTurn(channel);
  if (safe.state === "completed" || safe.state === "revoked") throw new Error("Zero Risk turn is already terminal");
  if (safe.connectorStarted) return { started: true, duplicate: true };
  safe.connectorStarted = true;
  activateSafeTurn(channel!, safe);
  return { started: true, duplicate: false };
}

export function confirmSafeTurnSent(
  channel: TurnChannel | undefined,
  surfaceNonce: string,
): { confirmed: true; duplicate: boolean } {
  assertSurfaceNonce(surfaceNonce);
  const safe = requireSafeTurn(channel);
  if (safe.surfaceNonce !== surfaceNonce) {
    throw new Error("Zero Risk local browser binding does not match this turn");
  }
  if (safe.state === "completed" || safe.state === "revoked") throw new Error("Zero Risk turn is already terminal");
  if (safe.launcherSent) return { confirmed: true, duplicate: true };
  safe.launcherSent = true;
  resolveSafeWaiters(safe.sentWaiters, undefined);
  activateSafeTurn(channel!, safe);
  return { confirmed: true, duplicate: false };
}

export function completeSafeTurn(
  channel: TurnChannel | undefined,
  finalAnswer: string,
): { completed: true; duplicate: boolean } {
  if (typeof finalAnswer !== "string" || finalAnswer.trim().length === 0) {
    throw new Error("Zero Risk turn final_answer must not be empty");
  }
  const safe = requireSafeTurn(channel);
  if (safe.state === "completed") {
    if (safe.finalAnswer !== finalAnswer) {
      throw new Error("Zero Risk turn completion conflicts with the accepted final_answer");
    }
    return { completed: true, duplicate: true };
  }
  if (safe.state === "revoked") throw new Error("Zero Risk turn is already terminal");
  if (safe.state !== "running") throw new Error("Zero Risk turn has not started");
  if (channel!.invocations.size > 0) {
    throw new Error(`Zero Risk turn cannot complete with ${channel!.invocations.size} pending Codex tool invocation(s)`);
  }
  if (channel!.activities.size > 0) {
    throw new Error(`Zero Risk turn cannot complete with ${channel!.activities.size} active Codex MCP request(s)`);
  }
  safe.state = "completed";
  safe.finalAnswer = finalAnswer;
  resolveSafeWaiters(safe.completionWaiters, finalAnswer);
  return { completed: true, duplicate: false };
}

export function waitForSafeStart(channel: TurnChannel | undefined, signal?: AbortSignal): Promise<void> {
  const safe = requireSafeTurn(channel);
  if (safe.state === "running" || safe.state === "completed") return Promise.resolve();
  if (safe.state === "revoked") return Promise.reject(new Error("Zero Risk turn was revoked"));
  return waitForSafeState(safe.startWaiters, signal, "Zero Risk turn start wait aborted");
}

export function waitForSafeSent(channel: TurnChannel | undefined, signal?: AbortSignal): Promise<void> {
  const safe = requireSafeTurn(channel);
  if (safe.launcherSent) return Promise.resolve();
  if (safe.state === "revoked") return Promise.reject(new Error("Zero Risk turn was revoked"));
  return waitForSafeState(safe.sentWaiters, signal, "Zero Risk turn Sent wait aborted");
}

export function waitForSafeCompletion(channel: TurnChannel | undefined, signal?: AbortSignal): Promise<string> {
  const safe = requireSafeTurn(channel);
  if (safe.state === "completed" && safe.finalAnswer !== undefined) return Promise.resolve(safe.finalAnswer);
  if (safe.state === "revoked") return Promise.reject(new Error("Zero Risk turn was revoked"));
  return waitForSafeState(safe.completionWaiters, signal, "Zero Risk turn completion wait aborted");
}

export function assertSafeHarnessRunning(channel: TurnChannel, allowCompaction = false): void {
  const safe = channel.safe;
  if (!safe) return;
  if (safe.state === "awaiting_start") {
    if (!safe.launcherSent) throw new Error("Zero Risk turn is waiting for the user's Sent confirmation");
    throw new Error("Zero Risk request is not connected yet. Call codex_turn_start with its request_id first");
  }
  if (safe.state !== "running") throw new Error("Zero Risk turn is already terminal");
  if (channel.compactionRequested && !allowCompaction) {
    throw new Error("Zero Risk turn is awaiting completion for Codex context compaction");
  }
}

export function revokeSafeTurn(channel: TurnChannel, reason: Error): void {
  if (!channel.safe) return;
  channel.safe.state = "revoked";
  rejectSafeWaiters(channel.safe.sentWaiters, reason);
  rejectSafeWaiters(channel.safe.startWaiters, reason);
  rejectSafeWaiters(channel.safe.completionWaiters, reason);
}

function activateSafeTurn(channel: TurnChannel, safe: SafeTurnControl): void {
  if (safe.state !== "awaiting_start" || !safe.launcherSent || !safe.connectorStarted) return;
  safe.state = "running";
  delete channel.environment.expiresAt;
  resolveSafeWaiters(safe.startWaiters, undefined);
}

function waitForSafeState<T>(
  waiters: Set<SafeWaiter<T>>,
  signal: AbortSignal | undefined,
  abortMessage: string,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new DOMException(abortMessage, "AbortError"));
  return new Promise<T>((resolveWait, rejectWait) => {
    const waiter: SafeWaiter<T> = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
    if (signal) {
      waiter.onAbort = () => {
        waiters.delete(waiter);
        rejectWait(new DOMException(abortMessage, "AbortError"));
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    waiters.add(waiter);
  });
}

function resolveSafeWaiters<T>(waiters: Set<SafeWaiter<T>>, value: T): void {
  for (const waiter of waiters) {
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(value);
  }
  waiters.clear();
}

function rejectSafeWaiters<T>(waiters: Set<SafeWaiter<T>>, error: Error): void {
  for (const waiter of waiters) {
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.reject(error);
  }
  waiters.clear();
}
