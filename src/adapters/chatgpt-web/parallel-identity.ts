import { createHash } from "node:crypto";
import type { CodexParsedRequest } from "../../types";
import { extractChatGptTurnIdentity } from "./environment";
import { chatGptTurnSessions } from "./turn-execution";
import type { ParallelAdmissionIdentity } from "./parallel-admission";

/** Native lifecycle metadata only; user/tool prose cannot choose a task tree. */
export function parallelAdmissionIdentity(parsed: CodexParsedRequest, namespace: string): ParallelAdmissionIdentity {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId) throw new Error("Parallel admission requires native thread identity");
  const metadata = (parsed._rawBody as { client_metadata?: { claude_subagent?: unknown } } | undefined)?.client_metadata;
  const child = metadata?.claude_subagent === true || Boolean(identity.parentThreadId);
  const group = chatGptTurnSessions.rootGroup(`${namespace}:${identity.threadId}`);
  return { group: createHash("sha256").update(group).digest("hex"),
    role: parsed._compactionRequest || parsed._localCompactionRequest ? "maintenance" : child ? "worker" : "root" };
}
