import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { lstatSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../../config";
import { decodeCompactionSummary, isReadableCompactionSummaryText, SUMMARY_PREFIX } from "../../responses/compaction";
import type { CodexMessage, CodexParsedRequest } from "../../types";
import { parseRequest } from "../../responses/parser";
import { readNativeThreadDelegation } from "../../responses/native-context";
import type { ChatGptTurnIdentity, ChatGptTurnUserRevision } from "./environment";
import { priorAbortedTurnIds, turnUserRevisionHistory } from "./turn-user-revision";
import { ChatGptWebAdapterError } from "./adapter-error";

interface CompletedCheckpoint {
  summaryHash: string;
  sourceHashes: ReadonlySet<string>;
  sourceTurnHash?: string;
  source?: ChatGptTurnUserRevision;
  sourceWasSyntheticInstruction?: boolean;
  taskMessage?: CodexMessage;
  taskItemId?: string;
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
        || !value.sourceHashes.every(hash)
        || (value.sourceTurnHash !== undefined && !hash(value.sourceTurnHash))
        || (value.sourceWasSyntheticInstruction !== undefined && typeof value.sourceWasSyntheticInstruction !== "boolean")) return;
      restored.set(key, { summaryHash: value.summaryHash, sourceHashes: new Set(value.sourceHashes), sourceTurnHash: value.sourceTurnHash,
        sourceWasSyntheticInstruction: value.sourceWasSyntheticInstruction });
    }
    for (const [key, value] of restored) checkpoints.set(key, value);
  } catch { /* Missing/corrupt proof remains fail-closed. */ }
}

function persistCheckpoints(next: ReadonlyMap<string, CompletedCheckpoint>): void {
  if (!checkpointPath) return;
  try {
    atomicWriteFile(checkpointPath, JSON.stringify({ version: 1, checkpoints: [...next].map(([key, value]) => [
      key, { summaryHash: value.summaryHash, sourceHashes: [...value.sourceHashes], sourceTurnHash: value.sourceTurnHash,
        sourceWasSyntheticInstruction: value.sourceWasSyntheticInstruction },
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

function matchesRevision(item: Record<string, unknown>, source: ChatGptTurnUserRevision): boolean {
  return item.id === source.itemId
    && digest([(item.internal_chat_message_metadata_passthrough as { turn_id?: unknown } | undefined)?.turn_id,
      item.type === "function_call_output" ? item.output : item.content]) === sourceDigest(source);
}

function isNativeGoalSource(item: Record<string, unknown> | undefined): boolean {
  const metadata = item?.internal_chat_message_metadata_passthrough as {
    turn_id?: unknown; content_item_kinds?: unknown;
  } | undefined;
  return item?.type === "message" && item.role === "user"
    && typeof item.id === "string" && !!item.id
    && typeof metadata?.turn_id === "string" && !!metadata.turn_id.trim()
    && Array.isArray(metadata.content_item_kinds) && metadata.content_item_kinds.length === 1
    && metadata.content_item_kinds[0] === "goal.internal_context";
}

export function rememberCompactionContinuation(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  sources: readonly ChatGptTurnUserRevision[],
  summary: string,
): void {
  const key = scope(parsed, identity);
  if (!key || !parsed._compactionRequest || !summary || sources.length < 1 || sources.length > 2) return;
  const input = (parsed._rawBody as { input?: Array<Record<string, unknown>> } | undefined)?.input;
  const previous = recoverCompactionInstruction(parsed, identity);
  const prior = acceptedCheckpoint(parsed, identity);
  const priorCheckpoint = prior?.checkpoint;
  const sourceItem = Array.isArray(input) ? input.find(item => item && matchesRevision(item, sources[0]!)) : undefined;
  const nativeGoal = isNativeGoalSource(sourceItem);
  // Preserve only a producer-identified task already accepted as this checkpoint's source.
  // Quoted goal/delegation text and ordinary tool outputs do not qualify.
  const taskMessage = sourceItem && (nativeGoal || readNativeThreadDelegation(sourceItem))
    ? parseRequest({ model: parsed.modelId, input: [sourceItem] }).context.messages[0]
    : priorCheckpoint?.taskMessage && priorCheckpoint.sourceHashes.has(sourceDigest(sources[0]))
      && !input?.slice(prior!.summaryIndex + 1).some(item => item && matchesRevision(item, sources[0]!))
      ? priorCheckpoint.taskMessage : undefined;
  const taskItemId = sourceItem && (nativeGoal || readNativeThreadDelegation(sourceItem))
    ? String(sourceItem.id) : taskMessage ? priorCheckpoint?.taskItemId : undefined;
  // Source extraction has already authenticated this synthetic native instruction. Native
  // compaction drops goal context and delegation outputs while retaining older human messages.
  const sourceWasSyntheticInstruction = nativeGoal || sources[0].itemId !== undefined && Array.isArray(input)
    && input.some(item => item?.id === sources[0]!.itemId && item.type === "function_call_output"
      && item.name === "send_message_to_thread" && item.namespace === "codex_app" && item.call_id === undefined
      && item.output === sources[0]!.content)
    // Later compactions no longer contain the synthetic item. Carry its provenance only
    // through an exact earlier completed checkpoint, never a newer steering instruction.
    || previous?.sourceWasSyntheticInstruction === true && previous.source.itemId === sources[0].itemId
      && sourceDigest(previous.source) === sourceDigest(sources[0]);
  const next = new Map(checkpoints);
  next.delete(key);
  next.set(key, {
    summaryHash: digest(summary), sourceHashes: new Set(sources.map(sourceDigest)),
    sourceTurnHash: sources[0]!.turnId ? digest(sources[0]!.turnId) : undefined,
    source: structuredClone(sources[0]),
    sourceWasSyntheticInstruction,
    ...(taskMessage ? { taskMessage: structuredClone(taskMessage), taskItemId } : {}),
  });
  while (next.size > MAX_CHECKPOINTS) next.delete(next.keys().next().value!);
  persistCheckpoints(next);
  checkpoints.clear();
  for (const [scope, checkpoint] of next) checkpoints.set(scope, checkpoint);
}

/** Restore dropped native task context without changing authorization or raw request history. */
export function restoreCompactionTaskMessages(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  revisions: readonly ChatGptTurnUserRevision[],
  requiredMessages?: Set<CodexMessage>,
  requiredSource?: ChatGptTurnUserRevision,
): CodexMessage[] {
  const accepted = acceptedCheckpoint(parsed, identity);
  const input = (parsed._rawBody as { input?: Array<Record<string, unknown>> } | undefined)?.input ?? [];
  const pin = (expected: CodexMessage | undefined, from: number, last = false, before = parsed.context.messages.length): number => {
    const matches = (message: CodexMessage, index: number) => index >= from && index < before && expected !== undefined
      && isDeepStrictEqual({ ...message, timestamp: 0 }, { ...expected, timestamp: 0 });
    const index = last ? parsed.context.messages.findLastIndex(matches) : parsed.context.messages.findIndex(matches);
    if (index < 0) throw new ChatGptWebAdapterError("The authenticated compaction instruction is missing from model context", {
      status: 409, errorType: "invalid_request_error", code: "compaction_source_unavailable", retryable: false,
    });
    requiredMessages!.add(parsed.context.messages[index]!);
    return index + 1;
  };
  if (!accepted) {
    if (requiredMessages && requiredSource) {
      const current = input.filter(item => item && revisions.some(revision => (
        requiredSource.turnId ? revision.turnId === requiredSource.turnId : sourceDigest(revision) === sourceDigest(requiredSource)
      ) && matchesRevision(item, revision)));
      let cursor = parsed.context.messages.length;
      for (const item of current.toReversed()) cursor = pin(parseRequest({ model: parsed.modelId, input: [item] }).context.messages[0], 0, true, cursor) - 1;
    }
    return parsed.context.messages;
  }
  const { checkpoint, summaryIndex } = accepted;
  // New steering supersedes the saved task, even when its wording repeats an older request.
  const newInstructions = input.slice(summaryIndex + 1).filter(item => item && revisions.some(revision =>
    matchesRevision(item, revision)));
  const messageIndex = parsed.context.messages.findLastIndex(message => {
    if (message.role !== "user") return false;
    const content = typeof message.content === "string" ? message.content
      : message.content.every(part => part.type === "text")
        ? message.content.map(part => part.type === "text" ? part.text : "").join("\n") : undefined;
    if (!isReadableCompactionSummaryText(content)) return false;
    const text = content!.slice(SUMMARY_PREFIX.length + 1);
    // v1 uses one newline; decoded v2 summaries use two.
    return digest(text) === checkpoint.summaryHash || text.startsWith("\n") && digest(text.slice(1)) === checkpoint.summaryHash;
  });
  if (newInstructions.length) {
    if (requiredMessages) {
      let cursor = messageIndex + 1;
      for (const item of newInstructions) cursor = pin(parseRequest({ model: parsed.modelId, input: [item] }).context.messages[0], cursor);
    }
    return parsed.context.messages;
  }
  const primaryHash = checkpoint.sourceHashes.values().next().value;
  const primary = revisions.find(revision => sourceDigest(revision) === primaryHash);
  const present = input.find(item => item && (
    checkpoint.taskItemId !== undefined && item.id === checkpoint.taskItemId
      || primary !== undefined && matchesRevision(item, primary)
  ));
  if (present) {
    if (requiredMessages) pin(parseRequest({ model: parsed.modelId, input: [present] }).context.messages[0], 0, true);
    return parsed.context.messages;
  }
  if (!checkpoint.taskMessage) return parsed.context.messages;
  if (messageIndex < 0) return parsed.context.messages;
  const taskMessage = structuredClone(checkpoint.taskMessage);
  requiredMessages?.add(taskMessage);
  return [...parsed.context.messages.slice(0, messageIndex + 1), taskMessage,
    ...parsed.context.messages.slice(messageIndex + 1)];
}

export function isAcceptedCompactionContinuation(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  source: ChatGptTurnUserRevision,
): boolean {
  const checkpoint = acceptedCheckpoint(parsed, identity, source)?.checkpoint;
  if (!checkpoint?.sourceHashes.has(sourceDigest(source))) return false;
  if (!checkpoint.source && checkpoint.sourceWasSyntheticInstruction !== false) {
    const primaryHash = checkpoint.sourceHashes.values().next().value;
    if (sourceDigest(source) !== primaryHash
      && !turnUserRevisionHistory(parsed._rawBody).some(revision => sourceDigest(revision) === primaryHash)) return false;
  }
  return true;
}

/** Native compaction may retain only its summary; recover the task solely from our completed handoff. */
export function recoverCompactionInstruction(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
): { source: ChatGptTurnUserRevision; summaryIndex: number; sourceWasSyntheticInstruction: boolean } | undefined {
  const accepted = acceptedCheckpoint(parsed, identity);
  if (!accepted) return undefined;
  const { checkpoint, summaryIndex } = accepted;
  if (checkpoint.source) return { source: structuredClone(checkpoint.source), summaryIndex,
    sourceWasSyntheticInstruction: checkpoint.sourceWasSyntheticInstruction === true };
  if (checkpoint.sourceWasSyntheticInstruction === false) return undefined;
  const revisions = turnUserRevisionHistory(parsed._rawBody);
  const primaryHash = checkpoint.sourceHashes.values().next().value;
  const primary = revisions.find(revision => sourceDigest(revision) === primaryHash);
  const input = (parsed._rawBody as { input: Array<Record<string, unknown>> }).input;
  if (primary) {
    const item = input.find(item => item && matchesRevision(item, primary));
    return { source: structuredClone(primary), summaryIndex,
      sourceWasSyntheticInstruction: checkpoint.sourceWasSyntheticInstruction === true
        || isNativeGoalSource(item) || (!!item && !!readNativeThreadDelegation(item)) };
  }
  if (input.slice(summaryIndex + 1).some(item => item && revisions.some(revision => matchesRevision(item, revision)))) return undefined;
  // Hashes authorize an exact source; an older retained alias cannot reconstruct its missing task.
  throw new ChatGptWebAdapterError(
    "ChatGPT cannot recover the current compacted task after restart. Supply the current native task context or a new instruction; the older retained message was not used as the task.",
    { status: 409, errorType: "invalid_request_error", code: "compaction_source_unavailable", retryable: false },
  );
}

function acceptedCheckpoint(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  source?: ChatGptTurnUserRevision,
): { checkpoint: CompletedCheckpoint; summaryIndex: number } | undefined {
  const key = scope(parsed, identity);
  const checkpoint = key ? checkpoints.get(key) : undefined;
  if (!key || !checkpoint) return undefined;
  const aborted = priorAbortedTurnIds(parsed._rawBody, identity.turnId ?? "");
  if (aborted.length) {
    let ownerHash = checkpoint.sourceTurnHash;
    if (!ownerHash) {
      // The first recorded digest is the primary instruction, not a retained representation.
      const primaryHash = checkpoint.sourceHashes.values().next().value;
      const primary = [...(source ? [source] : []), ...turnUserRevisionHistory(parsed._rawBody)]
        .find(candidate => sourceDigest(candidate) === primaryHash);
      if (primary?.turnId) ownerHash = digest(primary.turnId);
    }
    if (!ownerHash || aborted.some(owner => digest(owner) === ownerHash)) return undefined;
  }
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
