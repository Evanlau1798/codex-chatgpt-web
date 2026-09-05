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
  if (response.status !== "completed" || !Array.isArray(response.output) || response.output.length !== 1) return;
  const item = response.output[0];
  if (item?.type !== "compaction" || typeof item.encrypted_content !== "string") return;
  const summary = decodeCompactionSummary(item.encrypted_content);
  if (!summary) return;
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId || !identity.turnId) return;
  const source = extractChatGptCompactionSourceRevision(parsed);
  const sources = replacement ? [source, extractChatGptCompactionSourceRevision({
    ...parsed, _rawBody: { ...(parsed._rawBody as object), input: replacement },
  })] : [source];
  rememberCompactionContinuation(parsed, identity, sources, summary);
}
