import type { CodexParsedRequest } from "../../types";
import { hasEnvironmentContextFragment } from "./contextual-user-message";
import { codexTurnMetadataFromBody, extractChatGptTurnIdentity } from "./environment-identity";
import { isCurrentTurnInstruction, itemTurnId } from "./turn-user-revision";

export interface ChatGptUnattributedEnvironmentMessage {
  id: string;
  content: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Claims to locate in native history, never a source of filesystem authority. */
export function unattributedChatGptEnvironmentMessages(
  parsed: CodexParsedRequest,
): ChatGptUnattributedEnvironmentMessage[] | undefined {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const currentTurnId = extractChatGptTurnIdentity(parsed).turnId;
  const metadata = codexTurnMetadataFromBody(body);
  let afterCurrentInstruction = false;
  const messages: ChatGptUnattributedEnvironmentMessage[] = [];
  for (const value of input) {
    const item = record(value);
    if (currentTurnId && isCurrentTurnInstruction(item, metadata, currentTurnId)) afterCurrentInstruction = true;
    if (!hasEnvironmentContextFragment(item)) continue;
    // Refreshes after the current instruction are claims checked against its rollout, not history.
    if (afterCurrentInstruction) continue;
    const owner = itemTurnId(item);
    if (owner !== undefined && owner !== currentTurnId) continue;
    if (owner !== undefined || item.role !== "user" || typeof item.id !== "string" || !item.id) return undefined;
    messages.push({ id: item.id, content: item.content });
  }
  return messages.length > 0 ? messages : undefined;
}
