import { chatGptTurnUserRevisionHistory, extractChatGptCompactionSourceRevision, extractChatGptTurnIdentity } from "../adapters/chatgpt-web/environment";
import { rememberCompactionContinuation } from "../adapters/chatgpt-web/compaction-continuation";
import type { CodexParsedRequest } from "../types";
import { decodeCompactionSummary, extractCompactUserMessages } from "./compaction";

/** Bind the accepted checkpoint to its source and the native retained-user representation. */
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
  if (!replacement && compactionItem) {
    // Native v2 retains user messages but drops synthetic delegated tool outputs. Match the
    // exact retained instruction from the validated input, as the v1 replacement does above.
    // Never infer an instruction from the summary or relax turn/model/effort/source matching.
    const body = parsed._rawBody as { input?: unknown } | undefined;
    const retained = chatGptTurnUserRevisionHistory({
      ...parsed, _rawBody: { ...body, input: extractCompactUserMessages(body?.input) },
    }).at(-1);
    if (retained) sources.push(retained);
  }
  rememberCompactionContinuation(parsed, identity, sources, summary);
}
