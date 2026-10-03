import { createHash } from "node:crypto";
import type { CodexParsedRequest } from "../../types";
import { extractChatGptTurnIdentity } from "./environment";
import { chatGptTurnSessions } from "./turn-execution";
import type { ParallelAdmissionIdentity } from "./parallel-admission";
import { ChatGptWebAdapterError } from "./adapter-error";

/** Native lifecycle metadata only; user/tool prose cannot choose a task tree. */
export function parallelAdmissionIdentity(parsed: CodexParsedRequest, namespace: string,
  sessions: Pick<typeof chatGptTurnSessions, "groupAncestry"> = chatGptTurnSessions): ParallelAdmissionIdentity {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId) throw new Error("Parallel admission requires native thread identity");
  const metadata = (parsed._rawBody as { client_metadata?: { claude_subagent?: unknown } } | undefined)?.client_metadata;
  const child = metadata?.claude_subagent === true || Boolean(identity.parentThreadId);
  const ancestry = sessions.groupAncestry(`${namespace}:${identity.threadId}`);
  // Codex V2 ignores agents.max_depth. Enforce flat native ancestry here,
  // independently of slot occupancy and never from user/tool message text.
  const nativeDepth = identity.agentName?.startsWith("/root/")
    ? identity.agentName.split("/").filter(Boolean).length - 1 : undefined;
  if (identity.parentThreadId && (ancestry.depth > 1 || (nativeDepth !== undefined && nativeDepth > 1))) {
    throw new ChatGptWebAdapterError("Nested native workers are disabled for parallel admission; no provider Send was made.",
      { status: 409, errorType: "invalid_request_error", code: "parallel_nested_worker", retryable: false });
  }
  const group = ancestry.root;
  return { group: createHash("sha256").update(group).digest("hex"),
    role: parsed._compactionRequest || parsed._localCompactionRequest ? "maintenance" : child ? "worker" : "root" };
}
