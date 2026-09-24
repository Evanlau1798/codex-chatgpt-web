import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../../config";
import { decodeCompactionSummary, isReadableCompactionSummaryText, SUMMARY_PREFIX } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import type { ChatGptTurnIdentity, ChatGptTurnUserRevision } from "./environment";

interface CompletedCheckpoint {
  summaryHash: string;
  sourceHashes: ReadonlySet<string>;
  source?: ChatGptTurnUserRevision;
}

// Only daemon-recorded digests authorize a handoff; replay text alone is never evidence.
const checkpoints = new Map<string, CompletedCheckpoint>();
const MAX_CHECKPOINTS = 256;
let checkpointPath: string | undefined;

/** Production serve startup opts into persistence; isolated library users remain memory-only. */
export function loadCompactionContinuationState(path: string): void {
  checkpointPath = path;
  checkpoints.clear();
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.size > 128 * 1024) return;
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (raw?.version !== 1 || !Array.isArray(raw.checkpoints) || raw.checkpoints.length > MAX_CHECKPOINTS) return;
    const restored = new Map<string, CompletedCheckpoint>();
    const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    for (const entry of raw.checkpoints) {
      if (!Array.isArray(entry) || entry.length !== 2) return;
      const [key, value] = entry;
      if (!hash(key) || restored.has(key) || !hash(value?.summaryHash)
        || !Array.isArray(value.sourceHashes) || value.sourceHashes.length < 1 || value.sourceHashes.length > 2
        || !value.sourceHashes.every(hash)) return;
      restored.set(key, { summaryHash: value.summaryHash, sourceHashes: new Set(value.sourceHashes) });
    }
    for (const [key, value] of restored) checkpoints.set(key, value);
  } catch { /* Missing/corrupt proof remains fail-closed. */ }
}

function persistCheckpoints(next: ReadonlyMap<string, CompletedCheckpoint>): void {
  if (!checkpointPath) return;
  try {
    atomicWriteFile(checkpointPath, JSON.stringify({ version: 1, checkpoints: [...next].map(([key, value]) => [
      key, { summaryHash: value.summaryHash, sourceHashes: [...value.sourceHashes] },
    ]) }));
  } catch {
    throw new Error("Cannot acknowledge compaction checkpoint: continuation proof persistence failed");
  }
}

function scope(parsed: CodexParsedRequest, identity: ChatGptTurnIdentity): string | undefined {
  if (!identity.threadId || !identity.turnId) return undefined;
  return digest([identity.threadId, identity.turnId, parsed.modelId, parsed.options.reasoning,
    ...(parsed._chatgptModelFamily ? [parsed._chatgptModelFamily] : []),
  ]);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourceDigest(source: ChatGptTurnUserRevision): string {
  return digest([source.turnId, source.content]);
}

export function rememberCompactionContinuation(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  sources: readonly ChatGptTurnUserRevision[],
  summary: string,
): void {
  const key = scope(parsed, identity);
  if (!key || !parsed._compactionRequest || !summary || sources.length < 1 || sources.length > 2) return;
  const next = new Map(checkpoints);
  next.delete(key);
  next.set(key, {
    summaryHash: digest(summary), sourceHashes: new Set(sources.map(sourceDigest)),
    source: structuredClone(sources[0]!),
  });
  while (next.size > MAX_CHECKPOINTS) next.delete(next.keys().next().value!);
  persistCheckpoints(next);
  checkpoints.clear();
  for (const [scope, checkpoint] of next) checkpoints.set(scope, checkpoint);
}

export function isAcceptedCompactionContinuation(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  source: ChatGptTurnUserRevision,
): boolean {
  return acceptedCheckpoint(parsed, identity)?.checkpoint.sourceHashes.has(sourceDigest(source)) === true;
}

/** Native compaction may retain only its summary; recover the task solely from our completed handoff. */
export function recoverCompactionInstruction(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
): { source: ChatGptTurnUserRevision; summaryIndex: number } | undefined {
  const accepted = acceptedCheckpoint(parsed, identity);
  return accepted?.checkpoint.source
    ? { source: structuredClone(accepted.checkpoint.source), summaryIndex: accepted.summaryIndex } : undefined;
}

function acceptedCheckpoint(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
): { checkpoint: CompletedCheckpoint; summaryIndex: number } | undefined {
  const key = scope(parsed, identity);
  const checkpoint = key ? checkpoints.get(key) : undefined;
  if (!key || !checkpoint) return undefined;
  const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
  if (!Array.isArray(input)) return undefined;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index] as Record<string, unknown> | null;
    if (!item || typeof item !== "object") continue;
    let summary: string | null;
    if (["compaction", "compaction_summary", "context_compaction"].includes(String(item.type))) {
      summary = typeof item.encrypted_content === "string" ? decodeCompactionSummary(item.encrypted_content) : null;
    } else {
      if (item.type !== "message" || item.role !== "user") continue;
      const text = typeof item.content === "string" ? item.content : Array.isArray(item.content)
        ? item.content.map(part => part?.text ?? "").join("\n") : "";
      if (!isReadableCompactionSummaryText(text)) continue;
      summary = text.slice(SUMMARY_PREFIX.length + 1);
    }
    const owner = (item.internal_chat_message_metadata_passthrough as { turn_id?: unknown } | undefined)?.turn_id;
    if (owner !== undefined && owner !== identity.turnId) return undefined;
    return summary !== null && acceptsSummary(key, checkpoint, summary) ? { checkpoint, summaryIndex: index } : undefined;
  }
  return undefined;
}

function acceptsSummary(key: string, checkpoint: CompletedCheckpoint, summary: string): boolean {
  if (digest(summary) !== checkpoint.summaryHash) return false;
  // A long-running continuation does not become invalid merely because time passed. Keep the
  // bounded registry ordered by actual use instead of expiring a still-active native turn.
  checkpoints.delete(key);
  checkpoints.set(key, checkpoint);
  return true;
}
