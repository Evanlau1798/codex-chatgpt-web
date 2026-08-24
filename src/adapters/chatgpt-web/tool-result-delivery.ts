import { createHash } from "node:crypto";
import type { CodexToolResultMessage } from "../../types";
import { codexToolResultToBrokerResult } from "./compaction-handoff";
import type { BrokerToolResult, TurnBrokerOwner } from "./turn-broker";
import type { BrokerToolRequest } from "./turn-broker";
import type { ChatGptTurnSession } from "./turn-execution";
import type { PendingSteeringMessage } from "./steering-feed";

const CODEX_AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_AGENT_PATH = /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
const CODEX_AGENT_REFERENCE = /^\/?[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;

export interface CodexAgentLifecycleTarget {
  reference: string;
  threadId?: string;
}

export interface ChatGptToolResultDeliveryOptions {
  onSpawnedCodexAgent?: (agent: CodexAgentLifecycleTarget) => void;
  onInterruptedCodexAgent?: (agent: CodexAgentLifecycleTarget) => void;
  onClosedCodexAgent?: (agent: CodexAgentLifecycleTarget) => void;
  onClaudeAgentMessage?: (message: { recipient: string; content: string; deliveryId: string }) => void;
}

export function claudeSteeringMarker(turnToken: string): string {
  return `CODEX_CLAUDE_STEERING_${createHash("sha256").update(turnToken).digest("hex").slice(0, 16)}`;
}

export function claudeAdditiveSteeringInstruction(steering: string, marker?: string): string {
  const instruction = `Additional user guidance for the current task:\n\n${steering}\n\n`
    + "Apply this guidance once to the ongoing work. Continue the existing task unless the guidance explicitly asks to stop or replace it. "
    + "Respond naturally when the guidance itself requests a response; do not add a separate receipt otherwise.";
  return marker ? `<${marker}>\n${instruction}\n</${marker}>` : instruction;
}

function withClaudeSteering(
  result: BrokerToolResult,
  messages: PendingSteeringMessage[],
  turnToken: string,
  toolCallId: string,
): BrokerToolResult {
  const content = [...result.content];
  const marker = claudeSteeringMarker(turnToken);
  const event = JSON.stringify({
    version: 1,
    kind: "mid_turn_user_messages",
    boundary: { kind: "tool_result", tool_call_id: toolCallId },
    messages: messages.map(message => ({
      delivery_id: message.deliveryId,
      sequence: message.sequence,
      source: message.source,
      content: message.content,
    })),
  });
  const instruction = `<${marker}>\n${event}\n`
    + "Treat each messages item as independent guidance at this boundary. Apply each delivery_id once in sequence order; "
    + "source identifies whether content came from the user or the coordinating agent. Continue the existing task unless the content explicitly asks to stop or replace it. "
    + "Respond naturally when the content requests a response; otherwise do not add a separate receipt.\n"
    + `</${marker}>`;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const item = content[index];
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "text"
      || typeof (item as { text?: unknown }).text !== "string") continue;
    content[index] = {
      ...item,
      text: `${(item as { text: string }).text}\n\n${instruction}`,
    };
    return { ...result, content };
  }
  return {
    ...result,
    content: [...content, { type: "text", text: instruction }],
  };
}

function validAgentReference(value: unknown): value is string {
  return typeof value === "string" && value.length <= 1024
    && (CODEX_AGENT_ID.test(value) || CODEX_AGENT_REFERENCE.test(value));
}

function spawnedCodexAgent(
  request: BrokerToolRequest | undefined,
  result: BrokerToolResult,
): CodexAgentLifecycleTarget | undefined {
  if (result.isError) return undefined;
  const structured = result.structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return undefined;
  if (request?.wireName === "multi_agent_v1__spawn_agent") {
    const agentId = (structured as { agent_id?: unknown }).agent_id;
    return typeof agentId === "string" && CODEX_AGENT_ID.test(agentId)
      ? { reference: agentId, threadId: agentId }
      : undefined;
  }
  if (request?.wireName === "collaboration__spawn_agent") {
    const taskName = (structured as { task_name?: unknown }).task_name;
    return validAgentReference(taskName) && CODEX_AGENT_PATH.test(taskName)
      ? { reference: taskName }
      : undefined;
  }
  return undefined;
}

function lifecycleTarget(
  request: BrokerToolRequest | undefined,
  result: BrokerToolResult,
  action: "interrupt_agent" | "close_agent",
): CodexAgentLifecycleTarget | undefined {
  if (result.isError) return undefined;
  const expected = request?.wireName === `multi_agent_v1__${action}`
    || request?.wireName === `collaboration__${action}`;
  if (!expected) return undefined;
  const target = request.arguments?.target;
  if (!validAgentReference(target)) return undefined;
  return CODEX_AGENT_ID.test(target)
    ? { reference: target, threadId: target }
    : { reference: target };
}

function claudeAgentMessage(
  request: BrokerToolRequest | undefined,
  result: BrokerToolResult,
): { recipient: string; content: string; deliveryId: string } | undefined {
  if (result.isError || request?.wireName !== "SendMessage") return undefined;
  const recipient = request.arguments?.to ?? request.arguments?.recipient;
  const content = request.arguments?.message ?? request.arguments?.content;
  return typeof recipient === "string" && recipient.length > 0 && recipient.length <= 1024
    && typeof content === "string" && content.trim().length > 0
    ? { recipient, content, deliveryId: request.callId }
    : undefined;
}

export async function completeChatGptToolResults(
  session: ChatGptTurnSession,
  broker: Pick<TurnBrokerOwner, "completeTool">,
  token: string,
  results: CodexToolResultMessage[],
  options: ChatGptToolResultDeliveryOptions = {},
): Promise<void> {
  const outstanding = session.outstanding();
  if (results.length !== outstanding.length) {
    throw new Error(`Codex returned ${results.length} of ${outstanding.length} results for a parallel ChatGPT tool batch`);
  }
  const steering = session.peekPendingClaudeSteering();
  for (const [index, message] of results.entries()) {
    const isBoundary = steering && index === results.length - 1;
    const result = codexToolResultToBrokerResult(message);
    const request = outstanding.find(candidate => candidate.callId === message.toolCallId);
    const spawnedAgent = spawnedCodexAgent(request, result);
    if (spawnedAgent) options.onSpawnedCodexAgent?.(spawnedAgent);
    const interruptedAgent = lifecycleTarget(request, result, "interrupt_agent");
    if (interruptedAgent) options.onInterruptedCodexAgent?.(interruptedAgent);
    const closedAgent = lifecycleTarget(request, result, "close_agent");
    if (closedAgent) options.onClosedCodexAgent?.(closedAgent);
    const agentMessage = claudeAgentMessage(request, result);
    await broker.completeTool(token, message.toolCallId, isBoundary
      ? withClaudeSteering(result, steering.messages, token, message.toolCallId)
      : result);
    session.markResultDelivered(message.toolCallId, message);
    if (agentMessage) options.onClaudeAgentMessage?.(agentMessage);
    if (isBoundary) {
      session.acknowledgePendingClaudeSteering(steering.count);
      console.info(`[chatgpt-web] delivered additive Claude steering prompts=${steering.count} boundary=tool_result`);
    }
  }
}
