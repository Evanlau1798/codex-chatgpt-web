import { createHash } from "node:crypto";
import type { CodexParsedRequest } from "../../types";
import { SUMMARY_PREFIX } from "../../responses/compaction";
import { extractChatGptTurnIdentity } from "./environment";

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
  const raw = parsed._rawBody as { input?: unknown[]; client_metadata?: { claude_subagent?: unknown } } | undefined;
  return createHash("sha256").update(JSON.stringify({
    namespace,
    threadId: identity.threadId,
    claudeAgent: raw?.client_metadata?.claude_subagent === true ? identity.turnId : null,
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    compaction: compactionEpoch(raw?.input),
  })).digest("hex");
}
