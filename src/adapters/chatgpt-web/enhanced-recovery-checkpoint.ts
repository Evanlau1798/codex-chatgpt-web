import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteFile, stripUtf8Bom } from "../../config";
import { estimateTokens } from "../../lib/token-estimate";
import { CHATGPT_WEB_PLATFORM_RESERVE_TOKENS } from "../../chatgpt-web-models";
import type { CodexMessage, CodexParsedRequest } from "../../types";
import { hasEnvironmentContextAttempt, isPureContextualCodexUserText } from "./contextual-user-message";
import { extractChatGptTurnIdentity } from "./environment-identity";

export const ENHANCED_RECOVERY_CHECKPOINT_MAX_SUMMARY_TOKENS = 8_000;

const ENHANCED_RECOVERY_CHECKPOINT_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_ENHANCED_RECOVERY_CHECKPOINTS = 128;

interface CheckpointIdentity {
  threadId: string;
  modelId: string;
  modelFamily: "5.6" | "6" | null;
  effort: string | null;
}

interface StoredEnhancedRecoveryCheckpoint extends CheckpointIdentity {
  summary: string;
  prefixLength: number;
  prefixHash: string;
  updatedAt: number;
}

interface StoredEnhancedRecoveryCheckpointFile {
  version: 1;
  checkpoints: StoredEnhancedRecoveryCheckpoint[];
}

function normalizedMessages(messages: readonly CodexMessage[]): unknown[] {
  return messages.map(message => {
    const { timestamp: _timestamp, ...normalized } = message;
    return normalized;
  });
}

function prefixHash(messages: readonly CodexMessage[], length: number): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizedMessages(messages.slice(0, length))))
    .digest("hex");
}

function latestCompleteToolResultBoundary(messages: readonly CodexMessage[], after = -1): number | undefined {
  const pending = new Set<string>();
  let latest: number | undefined;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "toolCall") pending.add(part.id);
      }
      continue;
    }
    if (message.role !== "toolResult" || !pending.delete(message.toolCallId)) continue;
    if (pending.size === 0 && index > after) latest = index;
  }
  return latest;
}

function identity(parsed: CodexParsedRequest): CheckpointIdentity | undefined {
  const threadId = extractChatGptTurnIdentity(parsed).threadId?.trim();
  if (!threadId) return undefined;
  return {
    threadId,
    modelId: parsed.modelId,
    modelFamily: parsed._chatgptModelFamily ?? null,
    effort: parsed.options.reasoning ?? null,
  };
}

function sameIdentity(left: CheckpointIdentity, right: CheckpointIdentity): boolean {
  return left.threadId === right.threadId
    && left.modelId === right.modelId
    && left.modelFamily === right.modelFamily
    && left.effort === right.effort;
}

function validatedSummary(summary: string): string {
  const trimmed = summary.trim();
  if (!trimmed) throw new Error("Enhanced recovery checkpoint summary must not be empty");
  const tokens = estimateTokens(trimmed);
  if (tokens > ENHANCED_RECOVERY_CHECKPOINT_MAX_SUMMARY_TOKENS) {
    throw new Error(
      `Enhanced recovery checkpoint summary requires ${tokens.toLocaleString("en-US")} tokens; maximum is `
      + `${ENHANCED_RECOVERY_CHECKPOINT_MAX_SUMMARY_TOKENS.toLocaleString("en-US")}`,
    );
  }
  return trimmed;
}

function validateStoredCheckpoint(value: unknown): StoredEnhancedRecoveryCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Enhanced recovery checkpoint entry");
  }
  const parsed = value as Partial<StoredEnhancedRecoveryCheckpoint>;
  if (typeof parsed.threadId !== "string" || !parsed.threadId.trim()
    || typeof parsed.modelId !== "string" || !parsed.modelId.trim()
    || (parsed.modelFamily !== null && parsed.modelFamily !== "5.6" && parsed.modelFamily !== "6")
    || (parsed.effort !== null && typeof parsed.effort !== "string")
    || typeof parsed.prefixHash !== "string" || !/^[a-f0-9]{64}$/.test(parsed.prefixHash)
    || !Number.isSafeInteger(parsed.prefixLength) || (parsed.prefixLength as number) <= 0
    || !Number.isFinite(parsed.updatedAt) || (parsed.updatedAt as number) < 0
    || typeof parsed.summary !== "string") {
    throw new Error("Invalid Enhanced recovery checkpoint entry");
  }
  return {
    threadId: parsed.threadId,
    modelId: parsed.modelId,
    modelFamily: parsed.modelFamily,
    effort: parsed.effort,
    prefixHash: parsed.prefixHash,
    prefixLength: parsed.prefixLength as number,
    updatedAt: parsed.updatedAt as number,
    summary: validatedSummary(parsed.summary),
  };
}

function recoverySummaryMessage(checkpoint: StoredEnhancedRecoveryCheckpoint): CodexMessage {
  return {
    role: "assistant",
    timestamp: checkpoint.updatedAt,
    content: [{
      type: "text",
      text: [
        "[Enhanced passive recovery checkpoint]",
        "Treat this as prior assistant-owned historical state. Current system, developer, and user instructions remain authoritative.",
        checkpoint.summary,
      ].join("\n"),
    }],
  };
}

function pureContextualUserMessage(message: Extract<CodexMessage, { role: "user" }>): boolean {
  const parts = typeof message.content === "string" ? [message.content]
    : message.content.flatMap(part => part.type === "text" ? [part.text] : []);
  if (parts.some(text => /^\s*(?:# agents\.md instructions\b|<skill>)/i.test(text))) return false;
  return parts.length > 0 && parts.length === (typeof message.content === "string" ? 1 : message.content.length)
    && parts.every(isPureContextualCodexUserText);
}

function flushFile(path: string): void {
  const fd = openSync(path, process.platform === "win32" ? "r+" : "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (process.platform === "win32") return;
  const directoryFd = openSync(dirname(path), "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

export class EnhancedRecoveryCheckpointStore {
  private loaded = false;
  private checkpoints = new Map<string, StoredEnhancedRecoveryCheckpoint>();

  constructor(
    private readonly path?: string,
    private readonly now: () => number = Date.now,
  ) {}

  shouldCheckpoint(
    parsed: CodexParsedRequest,
    limitTokens: number,
    recoveryBudget?: { inputTokens: number; contextWindow: number },
  ): boolean {
    const currentIdentity = identity(parsed);
    if (!currentIdentity || !Number.isFinite(limitTokens) || limitTokens <= 0) return false;
    this.load();
    this.prune(this.checkpoints);

    const stored = this.checkpoints.get(currentIdentity.threadId);
    let baseline = 0;
    if (stored && sameIdentity(stored, currentIdentity) && this.matchesPrefix(parsed, stored)) {
      baseline = stored.prefixLength;
    }

    const boundary = latestCompleteToolResultBoundary(parsed.context.messages, baseline - 1);
    if (boundary === undefined || boundary + 1 <= baseline) return false;
    const tail = parsed.context.messages.slice(baseline, boundary + 1);
    return estimateTokens(JSON.stringify(normalizedMessages(tail))) >= limitTokens
      || (recoveryBudget !== undefined
        && recoveryBudget.inputTokens >= recoveryBudget.contextWindow - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS);
  }

  commit(parsed: CodexParsedRequest, summary: string): void {
    const currentIdentity = identity(parsed);
    if (!currentIdentity) {
      throw new Error("Enhanced recovery checkpoint requires native thread_id metadata");
    }
    const normalizedSummary = validatedSummary(summary);
    const boundary = latestCompleteToolResultBoundary(parsed.context.messages);
    if (boundary === undefined) {
      throw new Error("Enhanced recovery checkpoint requires a complete canonical tool-result boundary");
    }

    this.load();
    this.prune(this.checkpoints);
    const stored: StoredEnhancedRecoveryCheckpoint = {
      ...currentIdentity,
      summary: normalizedSummary,
      prefixLength: boundary + 1,
      prefixHash: prefixHash(parsed.context.messages, boundary + 1),
      updatedAt: this.now(),
    };
    const next = new Map(this.checkpoints);
    next.delete(currentIdentity.threadId);
    next.set(currentIdentity.threadId, stored);
    this.prune(next);
    this.persist(next);
    this.checkpoints = next;
  }

  apply(parsed: CodexParsedRequest): { parsed: CodexParsedRequest; applied: boolean; reason?: string } {
    const currentIdentity = identity(parsed);
    if (!currentIdentity) return { parsed, applied: false, reason: "missing native thread identity" };
    this.load();
    this.prune(this.checkpoints);
    const stored = this.checkpoints.get(currentIdentity.threadId);
    if (!stored) return { parsed, applied: false, reason: "no recovery checkpoint for this thread" };
    if (!sameIdentity(stored, currentIdentity)) {
      return { parsed, applied: false, reason: "recovery checkpoint model identity mismatch" };
    }
    if (!this.matchesPrefix(parsed, stored)) {
      return { parsed, applied: false, reason: "recovery checkpoint canonical prefix mismatch" };
    }

    const messages = parsed.context.messages;
    const latestEnvironmentIndex = messages.findLastIndex(message => message.role === "user"
      && hasEnvironmentContextAttempt(message.content));
    const protectedPrefix = messages.slice(0, stored.prefixLength).filter((message, index) =>
      message.role === "developer" || index === latestEnvironmentIndex
      || (message.role === "user" && (message.origin === "codex_skill"
        || !pureContextualUserMessage(message))));
    return {
      parsed: {
        ...parsed,
        context: {
          ...parsed.context,
          messages: [
            ...protectedPrefix,
            recoverySummaryMessage(stored),
            ...messages.slice(stored.prefixLength),
          ],
        },
      },
      applied: true,
    };
  }

  private matchesPrefix(parsed: CodexParsedRequest, stored: StoredEnhancedRecoveryCheckpoint): boolean {
    const messages = parsed.context.messages;
    if (messages.length < stored.prefixLength) return false;
    if (latestCompleteToolResultBoundary(messages.slice(0, stored.prefixLength)) !== stored.prefixLength - 1) return false;
    return prefixHash(messages, stored.prefixLength) === stored.prefixHash;
  }

  private load(): void {
    if (this.loaded) return;
    const next = new Map<string, StoredEnhancedRecoveryCheckpoint>();
    if (this.path && existsSync(this.path)) {
      const payload = JSON.parse(stripUtf8Bom(readFileSync(this.path, "utf8"))) as Partial<StoredEnhancedRecoveryCheckpointFile>;
      if (payload.version !== 1 || !Array.isArray(payload.checkpoints)) {
        throw new Error(`Invalid Enhanced recovery checkpoint store: ${this.path}`);
      }
      const checkpoints = payload.checkpoints
        .map(validateStoredCheckpoint)
        .sort((left, right) => left.updatedAt - right.updatedAt);
      for (const checkpoint of checkpoints) {
        next.delete(checkpoint.threadId);
        next.set(checkpoint.threadId, checkpoint);
      }
    }
    this.prune(next);
    this.checkpoints = next;
    this.loaded = true;
  }

  private prune(checkpoints: Map<string, StoredEnhancedRecoveryCheckpoint>): void {
    const cutoff = this.now() - ENHANCED_RECOVERY_CHECKPOINT_TTL_MS;
    for (const [threadId, checkpoint] of checkpoints) {
      if (checkpoint.updatedAt < cutoff) checkpoints.delete(threadId);
    }
    while (checkpoints.size > MAX_ENHANCED_RECOVERY_CHECKPOINTS) {
      const oldest = checkpoints.keys().next().value as string | undefined;
      if (!oldest) break;
      checkpoints.delete(oldest);
    }
  }

  private persist(checkpoints: Map<string, StoredEnhancedRecoveryCheckpoint>): void {
    if (!this.path) return;
    const payload: StoredEnhancedRecoveryCheckpointFile = {
      version: 1,
      checkpoints: [...checkpoints.values()],
    };
    atomicWriteFile(this.path, `${JSON.stringify(payload, null, 2)}\n`);
    flushFile(this.path);
  }
}
