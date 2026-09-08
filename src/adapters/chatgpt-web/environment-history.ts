import type { CodexParsedRequest } from "../../types";
import { extractChatGptTurnIdentity } from "./environment-identity";
import { itemTurnId } from "./turn-user-revision";

export interface ChatGptUnattributedEnvironmentMessage {
  id: string;
  content: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function messageText(item: Record<string, unknown>): string {
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return "";
  return item.content.flatMap(part => {
    const text = record(part)?.text;
    return typeof text === "string" ? [text] : [];
  }).join("\n");
}

/** Claims to locate in native history, never a source of filesystem authority. */
export function unattributedChatGptEnvironmentMessages(
  parsed: CodexParsedRequest,
): ChatGptUnattributedEnvironmentMessage[] | undefined {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const currentTurnId = extractChatGptTurnIdentity(parsed).turnId;
  const messages: ChatGptUnattributedEnvironmentMessage[] = [];
  for (const value of input) {
    const item = record(value);
    if (item?.type !== "message" || !/<\/?environment_context\b/i.test(messageText(item))) continue;
    const owner = itemTurnId(item);
    if (owner !== undefined && owner !== currentTurnId) continue;
    if (owner !== undefined || item.role !== "user" || typeof item.id !== "string" || !item.id) return undefined;
    messages.push({ id: item.id, content: item.content });
  }
  return messages.length > 0 ? messages : undefined;
}
