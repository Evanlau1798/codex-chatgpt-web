import { createHash } from "node:crypto";
import type { CodexParsedRequest } from "../../types";
import { chatGptTurnExecutionKey } from "./turn-execution-key";
import { currentTurnUserRevision } from "./turn-user-revision";
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

/** Canonical native owner + request revision, never a prompt-only global blacklist.
 * Transport flags/timestamps are excluded, but changed tool results and item identities are not.
 * The digest stays process-local and is never written to diagnostics or the error response.
 */
export function chatGptPromptFailureKey(parsed: CodexParsedRequest): string {
  const executionKey = chatGptTurnExecutionKey(parsed); // validates the required native identity
  const identity = extractChatGptTurnIdentity(parsed);
  const revision = currentTurnUserRevision(parsed._rawBody, identity.turnId!);
  return createHash("sha256").update(JSON.stringify({
    executionKey,
    revision,
    context: { ...parsed.context, messages: parsed.context.messages.map(({ timestamp: _timestamp, ...message }) => message) },
    options: parsed.options,
  })).digest("hex");
}

/** A native reconnect may refresh harness context, but must not resend a rejected user revision. */
export function chatGptModelFailureKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  const executionKey = chatGptTurnExecutionKey(parsed); // validates native identity and complete compaction input
  return createHash("sha256").update(JSON.stringify({
    executionKey: parsed._compactionRequest ? {
      turn: chatGptTurnRetryKey(parsed), modelId: parsed.modelId,
      modelFamily: parsed._chatgptModelFamily, reasoning: parsed.options.reasoning,
    } : executionKey,
    revision: parsed._compactionRequest
      ? (parsed._rawBody as { input: unknown[] }).input.filter(item => {
          // Refreshed harness instructions do not authorize resending a rejected compact turn.
          const role = item && typeof item === "object" ? (item as { role?: unknown }).role : undefined;
          return role !== "developer" && role !== "system";
        })
      : currentTurnUserRevision(parsed._rawBody, identity.turnId!),
  })).digest("hex");
}
