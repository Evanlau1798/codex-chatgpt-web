import { createHash } from "node:crypto";
import type { CodexToolResultMessage } from "../../types";
import { codexToolResultToBrokerResult } from "./compaction-handoff";
import type { BrokerToolResult, TurnBroker } from "./turn-broker";
import type { BrokerToolRequest } from "./turn-broker";
import type { ChatGptTurnSession } from "./turn-execution";
import type { PendingSteeringMessage } from "./steering-feed";

const CODEX_AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ChatGptToolResultDeliveryOptions {
  onSpawnedCodexAgent?: (agentId: string) => void;
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
      content: message.content,
    })),
  });
  const instruction = `<${marker}>\n${event}\n`
    + "Treat each messages item as an independent user event at this boundary. Apply each delivery_id once in sequence order; "
    + "only content is user-authored. Continue the existing task unless the content explicitly asks to stop or replace it.\n"
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

function spawnedCodexAgentId(
  request: BrokerToolRequest | undefined,
  result: BrokerToolResult,
): string | undefined {
  if (request?.wireName !== "multi_agent_v1__spawn_agent" || result.isError) return undefined;
  const structured = result.structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return undefined;
  const agentId = (structured as { agent_id?: unknown }).agent_id;
  return typeof agentId === "string" && CODEX_AGENT_ID.test(agentId) ? agentId : undefined;
}

export function completeChatGptToolResults(
  session: ChatGptTurnSession,
  broker: Pick<TurnBroker, "completeTool">,
  token: string,
  results: CodexToolResultMessage[],
  options: ChatGptToolResultDeliveryOptions = {},
): void {
  const outstanding = session.outstanding();
  if (results.length !== outstanding.length) {
    throw new Error(`Codex returned ${results.length} of ${outstanding.length} results for a parallel ChatGPT tool batch`);
  }
  const steering = session.claudeRootThreadId ? session.peekPendingSteering() : undefined;
  for (const [index, message] of results.entries()) {
    const isBoundary = steering && index === results.length - 1;
    const result = codexToolResultToBrokerResult(message);
    const request = outstanding.find(candidate => candidate.callId === message.toolCallId);
    const spawnedAgentId = spawnedCodexAgentId(request, result);
    if (spawnedAgentId) options.onSpawnedCodexAgent?.(spawnedAgentId);
    broker.completeTool(token, message.toolCallId, isBoundary
      ? withClaudeSteering(result, steering.messages, token, message.toolCallId)
      : result);
    session.markResultDelivered(message.toolCallId);
    if (isBoundary) {
      session.acknowledgePendingClaudeSteering(steering.count);
      console.info(`[chatgpt-web] delivered additive Claude steering prompts=${steering.count} boundary=tool_result`);
    }
  }
}
