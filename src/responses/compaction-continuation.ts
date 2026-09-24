import { extractChatGptCompactionSourceRevision, extractChatGptTurnIdentity } from "../adapters/chatgpt-web/environment";
import { rememberCompactionContinuation } from "../adapters/chatgpt-web/compaction-continuation";
import type { CodexParsedRequest } from "../types";
import { decodeCompactionSummary } from "./compaction";

/** Record only representations actually returned after the route's validation succeeds. */
export function rememberCompletedCompaction(
  parsed: CodexParsedRequest,
  response: Record<string, unknown>,
  replacement?: Record<string, unknown>[],
): void {
  if (response.status !== "completed" || !Array.isArray(response.output)) return;
  const compactionItem = parsed._compactionResponseFormat !== "message";
  const items = response.output.filter(item => item?.type === (compactionItem ? "compaction" : "message"));
  if (items.length !== 1 || (compactionItem && response.output.length !== 1)) return;
  const item = items[0];
  const summary = compactionItem
    ? (typeof item?.encrypted_content === "string" ? decodeCompactionSummary(item.encrypted_content) : null)
    : (item?.role === "assistant" && Array.isArray(item.content)
      ? item.content.filter((part: { type?: string; text?: unknown }) => part.type === "output_text" && typeof part.text === "string")
        .map((part: { text: string }) => part.text).join("")
      : null);
  if (!summary) return;
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId || !identity.turnId) return;
  const source = extractChatGptCompactionSourceRevision(parsed);
  const sources = replacement ? [source, extractChatGptCompactionSourceRevision({
    ...parsed, _rawBody: { ...(parsed._rawBody as object), input: replacement },
  })] : [source];
  rememberCompactionContinuation(parsed, identity, sources, summary);
}
