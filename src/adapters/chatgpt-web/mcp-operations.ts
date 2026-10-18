import { callTurnBroker } from "./turn-broker";
import { mcpJsonResult } from "./mcp-results";
function operationResult(value: Record<string, unknown>) {
  const native = value.result as { isError?: boolean } | undefined;
  return mcpJsonResult(value, native?.isError === true);
}

export async function startMcpOperation(socket: string, bindingId: string, operationKey: string,
  request: { wireName: string; freeform: boolean; arguments?: Record<string, unknown>; input?: string },
  token: string, signal?: AbortSignal) {
  const started = await callTurnBroker<{ operation_id: string }>(socket, {
    method: "start_operation", bindingId, operationKey, ...request,
  }, 5000, signal);
  // A short response grace preserves the fast path without bounding the work.
  return operationResult(await callTurnBroker(socket, { method: "read_operation", token,
    operationId: started.operation_id, waitMs: 1000 }, 5000, signal));
}

export async function resultMcpOperation(socket: string, token: string, operationId: string,
  waitMs: number, signal?: AbortSignal) {
  return operationResult(await callTurnBroker(socket, { method: "read_operation", token,
    operationId, waitMs }, waitMs + 5000, signal));
}
