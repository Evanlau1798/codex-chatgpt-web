import { createHash } from "node:crypto";
import type { CodexParsedRequest } from "../../types";
import { extractChatGptTurnIdentity } from "./environment";

interface ClaudeRetryMetadata {
  claude_request_hash?: unknown;
  claude_subagent?: unknown;
}

function claudeRequestHash(parsed: CodexParsedRequest): string | undefined {
  const metadata = (parsed._rawBody as {
    client_metadata?: ClaudeRetryMetadata;
  } | undefined)?.client_metadata;
  if (typeof metadata?.claude_subagent !== "boolean") return undefined;
  return typeof metadata.claude_request_hash === "string" && metadata.claude_request_hash.length > 0
    ? metadata.claude_request_hash
    : undefined;
}

/** Stable identity for limiting automatic retries of one logical client turn. */
export function chatGptTurnRetryKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) {
    throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-turn retry budgeting");
  }
  const requestHash = claudeRequestHash(parsed);
  return createHash("sha256").update(JSON.stringify({
    threadId: identity.threadId,
    turnId: identity.turnId,
    purpose: parsed._compactionRequest ? "compaction" : "response",
    ...(requestHash ? { claudeRequestHash: requestHash } : {}),
  })).digest("hex");
}
