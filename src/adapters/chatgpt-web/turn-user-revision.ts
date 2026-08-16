import { isContextualCodexUserMessage } from "./contextual-user-message";

export interface CurrentTurnUserRevision {
  content: unknown;
  turnId?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function itemTurnId(value: unknown): string | undefined {
  const turnId = record(record(value)?.internal_chat_message_metadata_passthrough)?.turn_id;
  return typeof turnId === "string" ? turnId : undefined;
}

/** Select a revision from the current turn without crossing a contextual-only turn boundary. */
export function currentTurnUserRevision(
  rawBody: unknown,
  expectedTurnId: string,
): CurrentTurnUserRevision | undefined {
  const body = record(rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  let contextualFallback: CurrentTurnUserRevision | undefined;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = record(input[index]);
    const ordinaryUser = item?.type === "message" && item.role === "user";
    if (!ordinaryUser && item?.type !== "agent_message") continue;
    const messageTurnId = itemTurnId(item);
    const serverOwnedId = typeof item.id === "string" && item.id.length > 0;
    if (messageTurnId === undefined && !serverOwnedId) continue;
    const revision = { content: item.content, ...(messageTurnId ? { turnId: messageTurnId } : {}) };
    if (messageTurnId !== undefined && messageTurnId !== expectedTurnId) {
      return contextualFallback ?? revision;
    }
    if (contextualFallback && messageTurnId === undefined) return contextualFallback;
    if (isContextualCodexUserMessage(item.content)) {
      contextualFallback ??= revision;
      continue;
    }
    return revision;
  }
  return contextualFallback;
}
