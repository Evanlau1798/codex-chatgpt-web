import { createHash } from "node:crypto";
import type { CodexParsedRequest } from "../../types";
import { SUMMARY_PREFIX } from "../../responses/compaction";
import { extractChatGptTurnIdentity } from "./environment";
import { chatGptTurnExecutionKey } from "./turn-execution-key";

const RETAINED_ENVELOPE_REVISION = 3;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function messageText(item: Record<string, unknown>): string | undefined {
  const content = item.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content.flatMap(block => block && typeof block === "object" && !Array.isArray(block)
    && typeof (block as { text?: unknown }).text === "string" ? [(block as { text: string }).text] : []).join("\n");
}

function compactionEpoch(input: unknown[] | undefined): unknown {
  return input?.findLast(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return record.type === "compaction"
      || record.type === "compaction_summary"
      || record.type === "context_compaction"
      || (record.role === "user" && messageText(record)?.startsWith(`${SUMMARY_PREFIX}\n`));
  }) ?? null;
}

export function chatGptModelSwitchEpoch(parsed: CodexParsedRequest): { itemId: string; turnId: string } | undefined {
  const input = record(parsed._rawBody)?.input;
  if (!Array.isArray(input)) return;
  const item = input.findLast(value => {
    const candidate = record(value);
    if (candidate?.type !== "message" || candidate.role !== "developer"
      || typeof candidate.id !== "string" || !candidate.id) return false;
    const metadata = record(candidate.internal_chat_message_metadata_passthrough);
    const kinds = metadata?.content_item_kinds;
    if (typeof metadata?.turn_id !== "string" || !metadata.turn_id
      || typeof metadata.create_time !== "number" || !Number.isFinite(metadata.create_time)
      || !Array.isArray(kinds) || !Array.isArray(candidate.content)
      || kinds.length !== candidate.content.length || !kinds.every(kind => typeof kind === "string")) return false;
    const modelSwitchIndexes = kinds.flatMap((kind, index) => kind === "model_switch.instructions" ? [index] : []);
    if (modelSwitchIndexes.length !== 1) return false;
    const part = record(candidate.content[modelSwitchIndexes[0]!]);
    if ((part?.type !== "input_text" && part?.type !== "text") || typeof part.text !== "string") return false;
    const text = part.text.trim();
    return /^<model_switch>[\s\S]*<\/model_switch>$/.test(text)
      && (text.match(/<\/?model_switch>/g)?.length ?? 0) === 2;
  });
  const itemId = record(item)?.id;
  const turnId = record(record(item)?.internal_chat_message_metadata_passthrough)?.turn_id;
  return typeof itemId === "string" && typeof turnId === "string" ? { itemId, turnId } : undefined;
}

export function chatGptConversationKey(parsed: CodexParsedRequest, namespace: string): string | undefined {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId) return undefined;
  const raw = parsed._rawBody as {
    input?: unknown[];
    client_metadata?: { claude_subagent?: unknown; claude_history_anchor?: unknown };
  } | undefined;
  // Claude Code replays a resumed subagent as a new partial request even though the agent id and
  // its local transcript remain stable. Its first request message therefore is not a canonical
  // history boundary. Root requests do replay their canonical prefix, so their anchor must still
  // rotate the Web conversation after manual or automatic compaction.
  const claudeHistoryAnchor = raw?.client_metadata?.claude_subagent === false
    && typeof raw.client_metadata.claude_history_anchor === "string"
    ? raw.client_metadata.claude_history_anchor
    : null;
  const codexSession = typeof raw?.client_metadata?.claude_subagent === "boolean"
    ? null : identity.promptCacheKey ?? null;
  return createHash("sha256").update(JSON.stringify({
    retainedEnvelopeRevision: RETAINED_ENVELOPE_REVISION,
    namespace,
    threadId: identity.threadId,
    claudeAgent: raw?.client_metadata?.claude_subagent === true ? identity.turnId : null,
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    compaction: compactionEpoch(raw?.input),
    modelSwitch: chatGptModelSwitchEpoch(parsed) ?? null,
    claudeHistoryAnchor,
    codexSession,
    // Codex rebuilds its base instructions on each request but binds their lifetime to the stable
    // prompt cache key. Turn-local developer and environment updates remain in the message suffix.
    systemPrompt: codexSession ? null : parsed.context.systemPrompt ?? [],
  })).digest("hex");
}

export function chatGptTurnTraceId(parsed: CodexParsedRequest, namespace: string): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  return createHash("sha256").update(JSON.stringify({
    namespace,
    threadId: identity.threadId,
    turnId: identity.turnId,
    ...(parsed._compactionRequest ? { compactionExecutionKey: chatGptTurnExecutionKey(parsed) } : {}),
    conversationKey: parsed._compactionRequest ? undefined : chatGptConversationKey(parsed, namespace),
  })).digest("hex").slice(0, 12);
}
