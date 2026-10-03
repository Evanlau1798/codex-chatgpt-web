import { isDeepStrictEqual } from "node:util";
import { Buffer } from "node:buffer";
import { opaqueId, type BrokerToolRequest, type BrokerToolResult } from "./turn-broker-protocol";
import { claimTurnActivity, completeTurnActivity } from "./turn-broker-completion";
import type { TurnChannel } from "./turn-broker-state";

const MAX_OPERATIONS = 64;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_RETAINED_BYTES = 32 * 1024 * 1024;
const MAX_WAITERS = 8;
export interface NativeOperation {
  id: string;
  key: string;
  activityId: string;
  request: Omit<BrokerToolRequest, "callId">;
  consumed: boolean;
  bytes: number;
  result?: BrokerToolResult;
  waiters: Set<() => void>;
}
function receipt(operation: NativeOperation) {
  return { operation_status: operation.result === undefined ? "pending" : "ready",
    operation_id: operation.id, native_invocation_complete: operation.result !== undefined,
    ...(operation.result !== undefined ? { result: operation.result } : {}) };
}
export function startNativeOperation(channel: TurnChannel, key: unknown,
  request: Omit<BrokerToolRequest, "callId">,
  enqueue: (request: Omit<BrokerToolRequest, "callId">) => Promise<BrokerToolResult> | BrokerToolResult) {
  if (channel.safe || typeof key !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new Error("Invalid native operation key");
  const operations = channel.nativeOperations ??= new Map();
  const prior = operations.get(key);
  if (prior) {
    if (!isDeepStrictEqual(prior.request, request)) throw new Error("Native operation key was reused for different work");
    return receipt(prior);
  }
  if ([...operations.values()].some(item => !item.consumed)) {
    throw new Error("Retrieve the outstanding native operation before starting different work in this turn");
  }
  // Keep consumed keys until owner retirement: evicting a key would allow an
  // ambiguous retry to execute the same side effect again.
  if (operations.size >= MAX_OPERATIONS) throw new Error("Native operation capacity for this turn reached; no new work was started");
  const operation: NativeOperation = { id: opaqueId("operation"), key, activityId: opaqueId("activity"),
    request: structuredClone(request), consumed: false, bytes: 0, waiters: new Set() };
  claimTurnActivity(channel, operation.activityId);
  operations.set(key, operation);
  const retain = (result: BrokerToolResult) => {
    if (operations.get(key) !== operation) return;
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(result)); } catch { bytes = Infinity; }
    const used = [...operations.values()].reduce((total, item) => total + item.bytes, 0);
    if (bytes > MAX_RESULT_BYTES || used + bytes > MAX_RETAINED_BYTES) {
      result = { isError: true, content: [{ type: "text", text: "Native operation completed, but its result exceeded retained capacity. Do not replay the command." }],
        structuredContent: { code: "native_operation_result_capacity", native_result_available: false, retryable: false } };
      bytes = Buffer.byteLength(JSON.stringify(result));
    }
    operation.result = JSON.parse(JSON.stringify(result)) as BrokerToolResult;
    operation.bytes = bytes;
    for (const notify of [...operation.waiters]) notify();
    try { console.info(`[chatgpt-web] broker trace=${channel.traceId} native_operation state=ready isError=${result.isError === true}`); }
    catch { /* Observational sink failure cannot change the operation. */ }
  };
  try {
    // The operation is broker-owned, not tied to this MCP response or connection.
    void Promise.resolve(enqueue(operation.request)).then(retain, () => retain({ isError: true,
      content: [{ type: "text", text: "Native operation failed or its owner was retired; do not replay." }],
      structuredContent: { code: "native_operation_failed", retryable: false } }));
  } catch (error) {
    operations.delete(key);
    completeTurnActivity(channel, operation.activityId);
    throw error;
  }
  return receipt(operation);
}

export async function readNativeOperation(channel: TurnChannel, id: unknown, waitMs: unknown, signal: AbortSignal) {
  if (typeof id !== "string" || !Number.isSafeInteger(waitMs) || (waitMs as number) < 0 || (waitMs as number) > 30000) throw new Error("Invalid native operation read");
  const operation = [...(channel.nativeOperations?.values() ?? [])].find(item => item.id === id);
  if (!operation) throw new Error("Native operation is invalid, expired or belongs to another turn");
  if (signal.aborted) throw new DOMException("Operation response wait aborted", "AbortError");
  if (operation.result === undefined && (waitMs as number) > 0) {
    if (operation.waiters.size >= MAX_WAITERS) throw new Error("Too many readers for this native operation");
    await new Promise<void>((resolve, reject) => {
      const done = () => { clearTimeout(timer); operation.waiters.delete(done); signal.removeEventListener("abort", abort); resolve(); };
      const abort = () => { clearTimeout(timer); operation.waiters.delete(done); signal.removeEventListener("abort", abort); reject(new DOMException("Operation response wait aborted", "AbortError")); };
      const timer = setTimeout(done, waitMs as number);
      operation.waiters.add(done);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  if (signal.aborted) throw new DOMException("Operation response wait aborted", "AbortError");
  if (channel.nativeOperations?.get(operation.key) !== operation) throw new Error("Native operation owner was retired");
  if (operation.result !== undefined && !operation.consumed) {
    operation.consumed = true;
    completeTurnActivity(channel, operation.activityId);
  }
  return receipt(operation);
}

export function clearNativeOperations(channel: TurnChannel) {
  const operations = channel.nativeOperations;
  if (!operations) return;
  channel.nativeOperations = undefined;
  for (const operation of operations.values()) {
    completeTurnActivity(channel, operation.activityId);
    for (const notify of [...operation.waiters]) notify();
  }
  operations.clear();
}
