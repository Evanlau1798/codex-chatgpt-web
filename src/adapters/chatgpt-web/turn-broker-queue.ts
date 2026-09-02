import type { BrokerToolRequest } from "./turn-broker-protocol";
import type { TurnChannel } from "./turn-broker-state";

export function takeQueuedTools(channel: TurnChannel): BrokerToolRequest[] {
  return channel.queuedCallIds.splice(0)
    .map(id => channel.invocations.get(id)?.request)
    .filter((request): request is BrokerToolRequest => Boolean(request));
}

export function scheduleToolWaiters(channel: TurnChannel): void {
  if (channel.queuedCallIds.length === 0 || channel.waiters.size === 0 || channel.batchTimer) return;
  channel.batchTimer = setTimeout(() => {
    channel.batchTimer = undefined;
    wakeToolWaiters(channel);
  }, 15);
}

function wakeToolWaiters(channel: TurnChannel): void {
  if (channel.queuedCallIds.length === 0 || channel.waiters.size === 0) return;
  const batch = takeQueuedTools(channel);
  console.info(`[chatgpt-web] broker trace=${channel.traceId} delivered calls=${batch.length}`
    + ` tools=${batch.map(request => request.wireName).join(",")}`);
  const waiters = [...channel.waiters];
  channel.waiters.clear();
  const first = waiters.shift();
  if (first) {
    if (first.signal && first.onAbort) first.signal.removeEventListener("abort", first.onAbort);
    first.resolve(batch);
  }
  for (const waiter of waiters) {
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.reject(new Error("another adapter waiter already claimed the queued tool batch"));
  }
}

export function rejectTurnChannel(channel: TurnChannel, error: Error): void {
  if (channel.batchTimer) clearTimeout(channel.batchTimer);
  channel.batchTimer = undefined;
  for (const waiter of channel.waiters) {
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.reject(error);
  }
  channel.waiters.clear();
  for (const invocation of channel.invocations.values()) invocation.reject(error);
  channel.invocations.clear();
  channel.queuedCallIds = [];
}
