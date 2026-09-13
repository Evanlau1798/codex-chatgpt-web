import { callTurnBroker } from "./turn-broker";
import { brokerMcpResult, mcpJsonResult } from "./mcp-results";

export async function startNativeAgentWait(socket: string, bindingId: string, wireName: string,
  args: Record<string, unknown>, signal?: AbortSignal) {
  // An unsupported broker rejects this dedicated method; never fall back to a blocking invoke.
  return brokerMcpResult(mcpJsonResult(await callTurnBroker(socket, {
    method: "start_agent_wait", bindingId, wireName, arguments: args,
  }, 5_000, signal)));
}

export async function readNativeAgentWait(socket: string, token: string, query: string, signal?: AbortSignal) {
  return mcpJsonResult(await callTurnBroker(socket, {
    method: "read_agent_wait", token, waitId: query.slice("__codex_wait_result__:".length),
  }, 5_000, signal));
}
