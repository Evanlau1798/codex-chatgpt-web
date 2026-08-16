import type { CodexParsedRequest } from "../../types";
import { claudeAgentTurnId } from "../../claude-session-identity";
import { extractChatGptTurnIdentity } from "./environment";
import { chatGptTurnSteeringId, type ChatGptTurnSessions } from "./turn-execution";
import type { ChatGptToolResultDeliveryOptions } from "./tool-result-delivery";

function isClaudeRequest(parsed: CodexParsedRequest): boolean {
  const metadata = (parsed._rawBody as {
    client_metadata?: { claude_subagent?: unknown };
  } | undefined)?.client_metadata;
  return typeof metadata?.claude_subagent === "boolean";
}

export function claudeAgentMessagingOptions(
  parsed: CodexParsedRequest,
  sessions: ChatGptTurnSessions,
): ChatGptToolResultDeliveryOptions {
  if (!isClaudeRequest(parsed)) return {};
  const threadId = extractChatGptTurnIdentity(parsed).threadId;
  if (!threadId) return {};
  return {
    onClaudeAgentMessage(message) {
      const result = sessions.steerClaudeAgent(
        chatGptTurnSteeringId(threadId, claudeAgentTurnId(message.recipient)),
        message.content,
        message.deliveryId,
      );
      console.info(`[chatgpt-web] Claude child message route=${result}`);
    },
  };
}
