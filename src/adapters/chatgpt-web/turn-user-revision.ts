import { isContextualCodexUserMessage } from "./contextual-user-message";
import { codexTurnMetadataFromBody } from "./environment-identity";

export interface CurrentTurnUserRevision {
  content: unknown;
  turnId?: string;
  itemId?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function itemTurnId(value: unknown): string | undefined {
  const turnId = record(record(value)?.internal_chat_message_metadata_passthrough)?.turn_id;
  return typeof turnId === "string" ? turnId : undefined;
}

/** V2 delivers tasks as agent_message; only this child's direct parent can revise its task. */
export function isUserOrParentInstruction(
  item: Record<string, unknown> | undefined,
  metadata?: Record<string, unknown>,
): item is Record<string, unknown> {
  if (item?.type === "message" && item.role === "user") {
    return !isContextualCodexUserMessage(item.content);
  }
  if (item?.type !== "agent_message" || typeof item.id !== "string" || !item.id
    || metadata?.subagent_kind !== "thread_spawn"
    || (metadata.request_kind !== "turn" && metadata.request_kind !== "compaction")
    || typeof metadata.thread_id !== "string" || !metadata.thread_id
    || typeof metadata.parent_thread_id !== "string" || !metadata.parent_thread_id
    || metadata.thread_id === metadata.parent_thread_id) return false;
  const agentName = metadata.agent_name;
  return typeof agentName === "string" && /^\/root\/(?:[^/]+\/)*[^/]+$/.test(agentName)
    && item.recipient === agentName
    && item.author === agentName.slice(0, agentName.lastIndexOf("/"));
}

function revision(item: Record<string, unknown>): CurrentTurnUserRevision {
  const turnId = itemTurnId(item);
  const itemId = typeof item.id === "string" && item.id.length > 0 ? item.id : undefined;
  return { content: item.content, ...(turnId ? { turnId } : {}), ...(itemId ? { itemId } : {}) };
}

export function turnUserRevisionHistory(rawBody: unknown): CurrentTurnUserRevision[] {
  const body = record(rawBody);
  const metadata = codexTurnMetadataFromBody(rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  return input.flatMap(value => {
    const item = record(value);
    if (!isUserOrParentInstruction(item, metadata)) return [];
    const turnId = itemTurnId(item);
    if (turnId === undefined && (typeof item.id !== "string" || !item.id)) return [];
    return [revision(item)];
  });
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
  const metadata = codexTurnMetadataFromBody(rawBody);
  const hasAgentMessage = input.some(value => record(value)?.type === "agent_message");
  let contextualFallback: CurrentTurnUserRevision | undefined;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = record(input[index]);
    const ordinaryUser = item?.type === "message" && item.role === "user";
    if (!ordinaryUser && !isUserOrParentInstruction(item, metadata)) continue;
    const messageTurnId = itemTurnId(item);
    const serverOwnedId = typeof item.id === "string" && item.id.length > 0;
    if (messageTurnId === undefined && !serverOwnedId) continue;
    const candidate = revision(item);
    const currentTurnAbortText = messageTurnId === expectedTurnId && isTurnAbortedNotice(item.content);
    if (isTurnAbortedNotice(item.content) && messageTurnId && messageTurnId !== expectedTurnId) continue;
    if (!currentTurnAbortText && hasAgentMessage
      && ordinaryUser && isContextualCodexUserMessage(item.content)) continue;
    if (messageTurnId !== undefined && messageTurnId !== expectedTurnId) {
      return contextualFallback ?? candidate;
    }
    if (contextualFallback && messageTurnId === undefined) return contextualFallback;
    if (!currentTurnAbortText && isContextualCodexUserMessage(item.content)) {
      contextualFallback ??= candidate;
      continue;
    }
    return candidate;
  }
  return contextualFallback;
}
