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

function isTurnAbortedNotice(content: unknown): boolean {
  const values = typeof content === "string" ? [content] : Array.isArray(content)
    ? content.flatMap(part => {
        const value = record(part);
        return (value?.type === "input_text" || value?.type === "text") && typeof value.text === "string"
          ? [value.text]
          : [];
      })
    : [];
  return /^<turn_aborted>[\s\S]*<\/turn_aborted>$/.test(values.join("\n").trim());
}

/** Only native metadata can identify a prior turn as aborted; literal current input is not authority. */
export function priorAbortedTurnIds(rawBody: unknown, currentTurnId: string): string[] {
  const body = record(rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  return [...new Set(input.flatMap(value => {
    const item = record(value);
    const turnId = itemTurnId(item);
    return item?.type === "message" && item.role === "user" && isTurnAbortedNotice(item.content)
      && turnId !== undefined && turnId !== currentTurnId ? [turnId] : [];
  }))];
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
    const currentTurnAbortText = messageTurnId === expectedTurnId && isTurnAbortedNotice(item.content);
    if (isTurnAbortedNotice(item.content) && messageTurnId && messageTurnId !== expectedTurnId) continue;
    if (messageTurnId !== undefined && messageTurnId !== expectedTurnId) {
      return contextualFallback ?? revision;
    }
    if (contextualFallback && messageTurnId === undefined) return contextualFallback;
    if (!currentTurnAbortText && isContextualCodexUserMessage(item.content)) {
      contextualFallback ??= revision;
      continue;
    }
    return revision;
  }
  return contextualFallback;
}
