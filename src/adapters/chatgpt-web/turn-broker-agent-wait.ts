import { isDeepStrictEqual } from "node:util";
import { namespacedToolName } from "../../types";
import { claimTurnActivity, completeTurnActivity } from "./turn-broker-completion";
import { CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS, chatGptMcpInvocationTimeout } from "./mcp-invocation";
import { isGatewayAgentWaitTool } from "./mcp-gateway";
import {
  agentWaitLogicalTimeoutMs,
  boundedConnectorToolArguments,
  CHATGPT_WEB_AGENT_WAIT_POLL_MS,
  execGateway,
} from "./mcp-tool-inventory";
import { execGatewayProgram } from "./native-command";
import { opaqueId, type BrokerToolRequest, type BrokerToolResult } from "./turn-broker-protocol";
import type { TurnChannel } from "./turn-broker-state";

export interface AgentWait {
  id: string;
  activityId: string;
  wireName: string;
  args: Record<string, unknown>;
  startedAt: number;
  consumed: boolean;
  result?: BrokerToolResult;
  timer?: ReturnType<typeof setTimeout>;
}

function receipt(wait: AgentWait) {
  return wait.result === undefined
    ? { operation_status: "pending", wait_id: wait.id, next_query: `__codex_wait_result__:${wait.id}` }
    : { operation_status: "ready", wait_id: wait.id, result: wait.result };
}

function timedOut(result: BrokerToolResult): boolean {
  const structured = result.structuredContent;
  return result.isError !== true
    && structured !== null
    && typeof structured === "object"
    && !Array.isArray(structured)
    && (structured as Record<string, unknown>).timed_out === true;
}

export function readAgentWait(channel: TurnChannel, id: unknown): unknown {
  const wait = channel.agentWait;
  if (typeof id !== "string" || !wait || wait.id !== id) throw new Error("Agent wait handle is invalid, expired, or revoked");
  if (wait.result !== undefined && !wait.consumed) {
    wait.consumed = true;
    completeTurnActivity(channel, wait.activityId);
    console.info(`[chatgpt-web] broker trace=${channel.traceId} agent wait retrieved elapsedMs=${Date.now() - wait.startedAt}`);
  }
  return receipt(wait);
}

export function clearAgentWait(channel: TurnChannel): void {
  const wait = channel.agentWait;
  if (!wait) return;
  if (wait.timer) clearTimeout(wait.timer);
  completeTurnActivity(channel, wait.activityId);
  channel.agentWait = undefined;
}

export function startAgentWait(
  channel: TurnChannel,
  wireName: string | undefined,
  args: Record<string, unknown> | undefined,
  enqueue: (request: Omit<BrokerToolRequest, "callId">) => Promise<BrokerToolResult> | BrokerToolResult,
  retire: (error: Error) => void,
): unknown {
  if (channel.safe || !wireName || !isGatewayAgentWaitTool(wireName)) throw new Error("Only Native2 wait_agent supports asynchronous waits");
  const arguments_ = args ?? {};
  const logicalTimeoutMs = agentWaitLogicalTimeoutMs(arguments_);
  const tools = channel.environment.tools;
  const direct = tools.find(tool => namespacedToolName(tool.namespace, tool.name) === wireName);
  const gateway = execGateway(channel.environment);
  if (direct?.freeform || (!direct && !gateway)) throw new Error("Native agent wait tool is unavailable in this turn");
  const previous = channel.agentWait;
  // ponytail: one unconsumed wait per turn; add multiple slots only for a demonstrated concurrent-wait need.
  if (previous && !previous.consumed) {
    if (previous.wireName !== wireName || !isDeepStrictEqual(previous.args, arguments_)) {
      throw new Error("Retrieve the existing agent wait result before starting a different wait");
    }
    return readAgentWait(channel, previous.id);
  }
  const wait: AgentWait = { id: opaqueId("wait"), activityId: opaqueId("activity"), wireName,
    args: structuredClone(arguments_), startedAt: Date.now(), consumed: false };
  claimTurnActivity(channel, wait.activityId);
  channel.agentWait = wait;
  const boundedArgs = boundedConnectorToolArguments(direct ?? wireName, arguments_);
  const request = direct
    ? { wireName, freeform: false, arguments: boundedArgs }
    : { wireName: "exec", freeform: true, input: execGatewayProgram(wireName, false,
      { arguments: boundedArgs }, tools.map(tool => namespacedToolName(tool.namespace, tool.name))) };
  let remainingSlices = logicalTimeoutMs / CHATGPT_WEB_AGENT_WAIT_POLL_MS;
  const startSlice = () => {
    if (logicalTimeoutMs > CHATGPT_WEB_AGENT_WAIT_POLL_MS && channel.environment.expiresAt !== undefined) {
      channel.environment.expiresAt = Math.max(
        channel.environment.expiresAt,
        Date.now() + CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS,
      );
    }
    const invocation = enqueue(request);
    wait.timer = setTimeout(() => retire(new Error("Native agent wait exceeded its transport deadline; do not replay")),
      chatGptMcpInvocationTimeout(channel.environment));
    void Promise.resolve(invocation).then(result => {
      if (channel.agentWait !== wait || wait.result !== undefined) return;
      if (wait.timer) clearTimeout(wait.timer);
      wait.timer = undefined;
      remainingSlices -= 1;
      if (timedOut(result) && remainingSlices > 0) {
        try {
          startSlice();
        } catch {
          clearAgentWait(channel);
        }
        return;
      }
      wait.result = result;
      console.info(`[chatgpt-web] broker trace=${channel.traceId} agent wait ready elapsedMs=${Date.now() - wait.startedAt}`);
    }, () => clearAgentWait(channel));
  };
  try {
    startSlice();
    console.info(`[chatgpt-web] broker trace=${channel.traceId} agent wait receipt`);
    return receipt(wait);
  } catch (error) {
    clearAgentWait(channel);
    throw error;
  }
}
