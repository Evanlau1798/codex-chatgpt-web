import { createHash } from "node:crypto";
import type { CodexParsedRequest } from "../../types";
import { SUMMARY_PREFIX } from "../../responses/compaction";
import { extractChatGptTurnIdentity } from "./environment";
import { chatGptTurnExecutionKey } from "./turn-execution-key";

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
  return createHash("sha256").update(JSON.stringify({
    namespace,
    threadId: identity.threadId,
    claudeAgent: raw?.client_metadata?.claude_subagent === true ? identity.turnId : null,
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    compaction: compactionEpoch(raw?.input),
    claudeHistoryAnchor,
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
