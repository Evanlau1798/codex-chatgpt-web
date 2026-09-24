import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { atomicWriteFile, stripUtf8Bom } from "../../config";
import { getCodexHome } from "../../codex-integration-shared";
import { isReadableCompactionSummaryText } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import {
  extractChatGptTurnEnvironment,
  extractChatGptCompactionSourceRevision,
  extractChatGptContinuationEnvironmentClaims,
  extractChatGptSteeringEnvironmentClaim,
  extractChatGptTurnIdentity,
  extractChatGptThreadSpawnLineage,
  extractChatGptRootThreadMetadata,
  hasCurrentChatGptEnvironmentContext,
  hasChatGptCalendarEnvironmentDelta,
  hasRawChatGptEnvironmentContext,
  isChatGptCompactionContinuation,
  MissingTrustedCodexEnvironmentError,
  type ChatGptSandboxPolicy,
  type ChatGptTurnEnvironment,
} from "./environment";
import { effectiveChatGptToolPolicy } from "./tool-policy";
import { resolveCurrentCodexRolloutEnvironment } from "./codex-rollout-environment";
import { unattributedChatGptEnvironmentMessages } from "./environment-history";
import { isAcceptedCompactionContinuation } from "./compaction-continuation";
import { hasEnvironmentContextFragment, isPureContextualCodexUserText } from "./contextual-user-message";
import { codexTurnMetadataFromBody } from "./environment-identity";
import {
  isCurrentTurnInstruction,
  isCurrentTurnInstructionCandidate,
  isNativeInstruction,
  itemTurnId,
  priorAbortedTurnIds,
  turnUserRevisionHistory,
} from "./turn-user-revision";

interface StoredThreadEnvironment {
  cwd: string;
  roots: string[];
  writableRoots: string[];
  sandboxPolicy: ChatGptSandboxPolicy;
  updatedAt: number;
}

type CurrentTurnAnchor = {
  id: string;
  type: string;
  role: unknown;
  content: unknown;
  author: unknown;
  recipient: unknown;
};

interface StoredThreadEnvironmentFile {
  version: 1;
  threads: Record<string, StoredThreadEnvironment>;
}

const MAX_THREAD_ENVIRONMENTS = 256;
const THREAD_ENVIRONMENT_TTL_MS = 30 * 24 * 60 * 60_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isSingleEnvelope(text: string, whole: RegExp, tags: RegExp): boolean {
  return whole.test(text) && (text.match(tags)?.length ?? 0) === 2;
}

function environmentContextPart(value: unknown): boolean {
  const part = record(value);
  return (part?.type === "input_text" || part?.type === "text") && typeof part.text === "string"
    && isSingleEnvelope(
      part.text.trim(),
      /^<environment_context>[\s\S]*<\/environment_context>$/i,
      /<\/?environment_context>/gi,
    );
}

function singleContextualPart(value: unknown): boolean {
  const part = record(value);
  return (part?.type === "input_text" || part?.type === "text") && typeof part.text === "string"
    && isPureContextualCodexUserText(part.text);
}

function pureContextualUserMessage(item: Record<string, unknown>): boolean {
  return item.type === "message" && item.role === "user"
    && Array.isArray(item.content) && item.content.length > 0
    && item.content.every(singleContextualPart);
}

function isPassiveCurrentContextualContinuation(item: Record<string, unknown> | undefined, turnId: string): boolean {
  const owner = itemTurnId(item);
  return !!item && typeof item.id === "string" && !!item.id && (owner === undefined || owner === turnId)
    && pureContextualUserMessage(item)
    && !(item.content as unknown[]).some(part => environmentContextPart(part) || goalContextPart(part));
}

function rolloutAnchor(item: Record<string, unknown> | undefined): CurrentTurnAnchor | undefined {
  if (!item || typeof item.id !== "string" || !item.id || typeof item.type !== "string" || !("content" in item)) return undefined;
  return {
    id: item.id,
    type: item.type,
    role: item.role,
    content: item.content,
    author: item.author,
    recipient: item.recipient,
  };
}

function modelSwitchMessage(item: Record<string, unknown> | undefined, turnId: string): boolean {
  if (!item || item.type !== "message" || item.role !== "developer" || itemTurnId(item) !== turnId) return false;
  const parts = typeof item.content === "string" ? [item.content] : Array.isArray(item.content) && item.content.length === 1
    ? item.content.flatMap(value => {
      const part = record(value);
      return (part?.type === "input_text" || part?.type === "text") && typeof part.text === "string" ? [part.text] : [];
    }) : [];
  return parts.length === 1
    && /^<model_switch>[\s\S]*<\/model_switch>$/.test(parts[0]!.trim())
    && (parts[0]!.match(/<\/?model_switch>/g)?.length ?? 0) === 2;
}

function currentTurnRolloutAnchor(
  input: unknown[],
  checkpointIndex: number,
  metadata: Record<string, unknown> | undefined,
  turnId: string,
  allowGoalAnchor: boolean,
): CurrentTurnAnchor | undefined {
  const suffix = input.slice(checkpointIndex + 1).map(record);
  const invalidTrailingUserAfter = (index: number): boolean => suffix.slice(index + 1).some(item => {
    if (item?.type !== "message" || item.role !== "user") return false;
    const owner = itemTurnId(item);
    return (owner !== undefined && owner !== turnId)
      || !pureContextualUserMessage(item)
      || (Array.isArray(item.content) && item.content.some(goalContextPart));
  });
  const invalidPassiveTrailingUserAfter = (index: number): boolean => suffix.slice(index + 1).some(item => (
    item?.type === "message" && item.role === "user" && !isPassiveCurrentContextualContinuation(item, turnId)
  ));
  const ordinaryIndex = suffix.findLastIndex(item => (
    isCurrentTurnInstructionCandidate(item, metadata, turnId) && !hasGoalContextAttempt(item)
  ));
  if (ordinaryIndex >= 0) {
    if (invalidTrailingUserAfter(ordinaryIndex)) return undefined;
    const ordinaryAnchor = rolloutAnchor(suffix[ordinaryIndex]);
    if (ordinaryAnchor) return ordinaryAnchor;
  }

  const modelSwitchIndex = suffix.findLastIndex(item => modelSwitchMessage(item, turnId));
  if (modelSwitchIndex >= 0 && !invalidPassiveTrailingUserAfter(modelSwitchIndex)) {
    const modelSwitchAnchor = rolloutAnchor(suffix[modelSwitchIndex]);
    if (modelSwitchAnchor) return modelSwitchAnchor;
  }

  const goal = allowGoalAnchor ? goalContinuationBoundary(suffix, metadata, turnId) : undefined;
  if (goal) {
    const goalAnchor = rolloutAnchor(suffix[goal.index]);
    if (goalAnchor) return goalAnchor;
  }

  const currentUserMessages = suffix.filter(item => {
    if (item?.type !== "message" || item.role !== "user" || typeof item.id !== "string" || !item.id) return false;
    const owner = itemTurnId(item);
    return owner === undefined || owner === turnId;
  });
  if (currentUserMessages.length === 0
    || !currentUserMessages.every(item => isPassiveCurrentContextualContinuation(item, turnId))) return undefined;
  return rolloutAnchor(currentUserMessages.at(-1));
}

function goalContextPart(value: unknown): boolean {
  const part = record(value);
  if ((part?.type !== "input_text" && part?.type !== "text") || typeof part.text !== "string") return false;
  const text = part.text.trim();
  return isSingleEnvelope(
    text,
    /^<codex_internal_context source="goal">[\s\S]*<\/codex_internal_context>$/,
    /<\/?codex_internal_context(?:\s+source="[a-z][a-z0-9_]*")?>/g,
  ) || isSingleEnvelope(text, /^<goal_context>[\s\S]*<\/goal_context>$/i, /<\/?goal_context>/gi);
}

function goalContextAttemptPart(value: unknown): boolean {
  const part = record(value);
  if ((part?.type !== "input_text" && part?.type !== "text") || typeof part.text !== "string") return false;
  const text = part.text.trim();
  return /^<\/?goal_context\b/i.test(text)
    || /^<codex_internal_context\b(?=[^>]*\bsource\s*=\s*(?:"goal"|'goal'|goal\b))/i.test(text)
    || /^<\/codex_internal_context\b/i.test(text);
}

function hasGoalContextAttempt(item: Record<string, unknown> | undefined): boolean {
  return item?.type === "message" && item.role === "user" && Array.isArray(item.content)
    && item.content.some(goalContextAttemptPart);
}

function goalContinuationBoundary(
  suffix: unknown[],
  metadata: Record<string, unknown> | undefined,
  turnId: string,
): { index: number } | undefined {
  const items = suffix.map(record);
  const goalIndexes = items.flatMap((item, index) => (
    itemTurnId(item) === turnId
      && item?.type === "message" && item.role === "user" && Array.isArray(item.content)
      && item.content.some(goalContextPart) ? [index] : []
  ));
  if (goalIndexes.length !== 1) return undefined;
  const goalIndex = goalIndexes[0]!;
  const goalContextCount = items.reduce((count, item) => count + (
    itemTurnId(item) === turnId
      && item?.type === "message" && item.role === "user" && Array.isArray(item.content)
      ? item.content.filter(goalContextPart).length : 0
  ), 0);
  if (goalContextCount !== 1) return undefined;
  let currentPrefixStarted = false;
  const validPrefix = items.slice(0, goalIndex + 1).every(item => {
    if (!item) return false;
    const owner = itemTurnId(item);
    if (owner !== turnId) {
      if (currentPrefixStarted) return false;
      if (owner !== undefined) return true;
      return item.type !== "message" && item.type !== "agent_message";
    }
    currentPrefixStarted = true;
    if (typeof item.id !== "string" || !item.id
      || item.type !== "message" || !Array.isArray(item.content) || item.content.length === 0) return false;
    if (item.role === "user") return item.content.every(singleContextualPart);
    return item.role === "developer" && item.content.every(part => {
      const content = record(part);
      return (content?.type === "input_text" || content?.type === "text") && typeof content.text === "string"
        && !/<\/?(?:environment_context|codex_internal_context)\b/i.test(content.text);
    });
  });
  const validTrailingHistory = items.slice(goalIndex + 1).every(item => {
    return !!item && typeof item.id === "string" && !!item.id
      && itemTurnId(item) === turnId
      && !isCurrentTurnInstruction(item, metadata, turnId)
      && (item.type !== "message" || item.role !== "user" || pureContextualUserMessage(item));
  });
  return validPrefix && validTrailingHistory ? { index: goalIndex } : undefined;
}

function latestCompactionIndex(input: unknown[]): number {
  let checkpointIndex = -1;
  for (let index = 0; index < input.length; index += 1) {
    const item = record(input[index]);
    const text = typeof item?.content === "string" ? item.content : Array.isArray(item?.content)
      ? item.content.map(part => record(part)?.text ?? "").join("\n") : "";
    if (item?.type === "compaction" || item?.type === "compaction_summary" || item?.type === "context_compaction"
      || (item?.role === "user" && isReadableCompactionSummaryText(text))) {
      checkpointIndex = index;
    }
  }
  return checkpointIndex;
}

function isAcceptedPostCompactionContext(parsed: CodexParsedRequest): boolean {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) return false;
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const checkpointIndex = latestCompactionIndex(input);
  if (checkpointIndex < 0) return false;

  const metadata = codexTurnMetadataFromBody(parsed._rawBody);
  const suffix = input.slice(checkpointIndex + 1);
  const hasCurrentSteering = suffix.some(value => isCurrentTurnInstruction(record(value), metadata, identity.turnId!));
  const suffixUserMessages = suffix.flatMap(value => {
    const item = record(value);
    return item?.type === "message" && item.role === "user" ? [item] : [];
  });
  const currentEnvironmentClaimCount = suffixUserMessages.reduce((count, item) => count + (
    Array.isArray(item.content) ? item.content.filter(environmentContextPart).length : 0
  ), 0);
  const goalBoundary = goalContinuationBoundary(suffix, metadata, identity.turnId);
  // Goal-driven continuation has no ordinary user revision. Its current, server-owned environment
  // still proceeds only through the canonical rollout comparison in resolve().
  if (!hasCurrentSteering && currentEnvironmentClaimCount >= 1 && goalBoundary
    && !extractChatGptThreadSpawnLineage(parsed) && extractChatGptRootThreadMetadata(parsed)) return true;
  if (!hasCurrentSteering) return false;

  const aborted = new Set(priorAbortedTurnIds(parsed._rawBody, identity.turnId));
  const sourceBody = { ...body, input: input.slice(0, checkpointIndex) };
  return turnUserRevisionHistory(sourceBody).some(source => (
    source.turnId !== identity.turnId
    && (source.turnId === undefined || !aborted.has(source.turnId))
    && isAcceptedCompactionContinuation(parsed, identity, source)
  ));
}

function pathIdentity(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function contains(root: string, path: string): boolean {
  const rel = relative(pathIdentity(root), pathIdentity(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function absolutePaths(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(path => typeof path !== "string" || !isAbsolute(path))) {
    throw new Error(`Invalid persisted ChatGPT thread ${field}`);
  }
  const unique = new Map<string, string>();
  for (const path of value.map(path => resolve(path as string))) {
    if (!unique.has(pathIdentity(path))) unique.set(pathIdentity(path), path);
  }
  return [...unique.values()];
}

function sandboxPolicy(value: unknown, roots: string[], writableRoots: string[]): ChatGptSandboxPolicy {
  const parsed = record(value);
  if (parsed?.type === "dangerFullAccess") {
    const rootIdentities = new Set(roots.map(pathIdentity));
    if (writableRoots.length !== roots.length || writableRoots.some(path => !rootIdentities.has(pathIdentity(path)))) {
      throw new Error("Invalid persisted ChatGPT danger-full-access roots");
    }
    return { type: "dangerFullAccess" };
  }
  if (parsed?.type === "workspaceWrite") {
    if (typeof parsed.networkAccess !== "boolean" || writableRoots.some(path => !roots.some(root => contains(root, path)))) {
      throw new Error("Invalid persisted ChatGPT workspace-write policy");
    }
    return { type: "workspaceWrite", writableRoots, networkAccess: parsed.networkAccess };
  }
  if (parsed?.type === "readOnly") {
    if (typeof parsed.networkAccess !== "boolean" || writableRoots.length !== 0) {
      throw new Error("Invalid persisted ChatGPT read-only policy");
    }
    return { type: "readOnly", networkAccess: parsed.networkAccess };
  }
  throw new Error("Invalid persisted ChatGPT sandbox policy");
}

function validateStoredEnvironment(value: unknown): StoredThreadEnvironment {
  const parsed = record(value);
  if (!parsed || typeof parsed.cwd !== "string" || !isAbsolute(parsed.cwd) || typeof parsed.updatedAt !== "number") {
    throw new Error("Invalid persisted ChatGPT thread environment");
  }
  const cwd = resolve(parsed.cwd);
  const roots = absolutePaths(parsed.roots, "roots");
  const writableRoots = Array.isArray(parsed.writableRoots) && parsed.writableRoots.length === 0
    ? []
    : absolutePaths(parsed.writableRoots, "writable roots");
  if (!roots.some(root => contains(root, cwd))) throw new Error("Persisted ChatGPT cwd is outside its roots");
  return {
    cwd,
    roots,
    writableRoots,
    sandboxPolicy: sandboxPolicy(parsed.sandboxPolicy, roots, writableRoots),
    updatedAt: parsed.updatedAt,
  };
}

function authority(environment: ChatGptTurnEnvironment, updatedAt: number): StoredThreadEnvironment {
  return {
    cwd: environment.cwd,
    roots: environment.roots,
    writableRoots: environment.writableRoots,
    sandboxPolicy: environment.sandboxPolicy,
    updatedAt,
  };
}

function sameAuthority(left: ChatGptTurnEnvironment, right: ChatGptTurnEnvironment): boolean {
  const samePaths = (a: string[], b: string[]): boolean => {
    const expected = new Set(b.map(pathIdentity));
    return a.length === expected.size && a.every(path => expected.has(pathIdentity(path)));
  };
  return pathIdentity(left.cwd) === pathIdentity(right.cwd)
    && samePaths(left.roots, right.roots)
    && samePaths(left.writableRoots, right.writableRoots)
    && left.sandboxPolicy.type === right.sandboxPolicy.type
    && (left.sandboxPolicy.type === "dangerFullAccess" || (right.sandboxPolicy.type !== "dangerFullAccess"
      && left.sandboxPolicy.networkAccess === right.sandboxPolicy.networkAccess));
}

/**
 * Codex emits its trusted environment envelope when a task starts or its environment changes,
 * not on every follow-up. This store carries only that trusted authority across turns. Tool
 * declarations are always taken from the current request and are never persisted.
 */
export class ChatGptThreadEnvironmentStore {
  private loaded = false;
  private readonly threads = new Map<string, StoredThreadEnvironment>();

  constructor(
    private readonly path?: string,
    private readonly now: () => number = Date.now,
    private readonly codexHome: string = getCodexHome(),
    private readonly sqliteHome?: string,
  ) {}

  resolve(parsed: CodexParsedRequest): ChatGptTurnEnvironment {
    const identity = extractChatGptTurnIdentity(parsed);
    let directEnvironment: ChatGptTurnEnvironment | undefined;
    let directError: unknown;
    try {
      directEnvironment = extractChatGptTurnEnvironment(parsed);
    } catch (error) {
      directError = error;
    }

    if (directError && !(directError instanceof MissingTrustedCodexEnvironmentError)) throw directError;
    if (!identity.threadId) {
      if (directEnvironment) return directEnvironment;
      throw directError;
    }

    const hasCurrentContext = hasCurrentChatGptEnvironmentContext(parsed);
    const lineage = extractChatGptThreadSpawnLineage(parsed);
    const currentCompaction = isChatGptCompactionContinuation(parsed);
    const postCompactionContext = !currentCompaction && isAcceptedPostCompactionContext(parsed);
    const body = record(parsed._rawBody);
    const input = Array.isArray(body?.input) ? body.input : [];
    const checkpointIndex = latestCompactionIndex(input);
    const metadata = codexTurnMetadataFromBody(body);
    const sourceBeforeCheckpoint = checkpointIndex >= 0
      ? [...input.slice(0, checkpointIndex)].reverse().find(value => isNativeInstruction(record(value), metadata))
      : undefined;
    const crossesForeignCompaction = checkpointIndex >= 0
      && itemTurnId(sourceBeforeCheckpoint) !== identity.turnId;
    const hasCurrentInstruction = !!identity.turnId
      && input.some(value => isCurrentTurnInstruction(record(value), metadata, identity.turnId!));
    const ordinaryContinuation = hasCurrentInstruction && !crossesForeignCompaction;
    const rootMetadata = extractChatGptRootThreadMetadata(parsed);
    const currentTurnAnchor = crossesForeignCompaction && !!identity.turnId && !currentCompaction && !postCompactionContext
      ? currentTurnRolloutAnchor(input, checkpointIndex, metadata, identity.turnId, !lineage && !!rootMetadata)
      : undefined;
    const historicalMessages = !hasCurrentContext && lineage
      ? unattributedChatGptEnvironmentMessages(parsed) : undefined;
    const rolloutIdentity = lineage ?? rootMetadata;
    // Automatic compaction has a current turn_context; standalone compaction has only its
    // source turn_context. Either must be the latest native record, never an arbitrary ancestor.
    const compactionSourceTurnId = parsed._compactionRequest || parsed._localCompactionRequest
      ? extractChatGptCompactionSourceRevision(parsed).turnId : undefined;
    if (parsed._rawBody !== undefined && rolloutIdentity && identity.turnId) {
      const rolloutEnvironment = resolveCurrentCodexRolloutEnvironment({
        codexHome: this.codexHome,
        ...(this.sqliteHome ? { sqliteHome: this.sqliteHome } : {}),
        lineage: rolloutIdentity,
        turnId: identity.turnId,
        ...(compactionSourceTurnId ? { compactionSourceTurnId } : {}),
        ...(historicalMessages ? { historicalEnvironmentMessages: historicalMessages } : {}),
        ...(currentTurnAnchor ? { currentTurnAnchor } : {}),
        tools: effectiveChatGptToolPolicy(parsed).tools,
      });
      if (rolloutEnvironment) {
        const calendarDelta = hasCurrentContext && !currentCompaction && hasChatGptCalendarEnvironmentDelta(parsed);
        if (calendarDelta && rolloutEnvironment.sandboxPolicy.type !== "dangerFullAccess") {
          throw new Error("Calendar environment delta conflicts with its current Codex rollout");
        }
        if (hasCurrentContext && !directEnvironment && !currentCompaction && !postCompactionContext
          && ordinaryContinuation && !calendarDelta) {
          const firstInstruction = input.findIndex(value => isCurrentTurnInstruction(record(value), metadata, identity.turnId!));
          const hasLaterRefresh = input.slice(firstInstruction + 1).some(value => hasEnvironmentContextFragment(record(value)));
          // An earlier preamble separated by steering needs two attributed current instructions.
          // A later refresh uses the existing per-claim/current-rollout comparison instead.
          if (!hasLaterRefresh && !extractChatGptSteeringEnvironmentClaim(parsed)) {
            throw new MissingTrustedCodexEnvironmentError("cwd");
          }
        }
        const currentClaims = hasCurrentContext ? extractChatGptContinuationEnvironmentClaims(parsed, calendarDelta) : [];
        if (currentClaims.some(claim => !sameAuthority(claim, rolloutEnvironment))) {
          throw new Error("Compaction continuation environment conflicts with its current Codex rollout");
        }
        if ((hasCurrentContext || crossesForeignCompaction)
          && !currentCompaction && !postCompactionContext && !ordinaryContinuation
          && !currentTurnAnchor) throw new MissingTrustedCodexEnvironmentError("cwd");
        this.set(rolloutIdentity.threadId, rolloutEnvironment);
        return rolloutEnvironment;
      }
    }

    if (directEnvironment) {
      this.set(identity.threadId, directEnvironment);
      return directEnvironment;
    }
    const missingEnvironment = directError as MissingTrustedCodexEnvironmentError;
    // Only a current native rollout can supersede an unrecognized historical envelope. Without
    // that proof, do not turn arbitrary history or an invalid update into cached authority.
    if (hasRawChatGptEnvironmentContext(parsed)) throw missingEnvironment;
    const sameThread = this.get(identity.threadId);
    if (sameThread) return {
      cwd: sameThread.cwd,
      roots: sameThread.roots,
      writableRoots: sameThread.writableRoots,
      sandboxPolicy: sameThread.sandboxPolicy,
      tools: effectiveChatGptToolPolicy(parsed).tools,
    };

    if (!lineage && identity.parentThreadId && identity.parentThreadId !== identity.threadId
      && !identity.agentName && !identity.subagentKind
      && this.inherit(identity.parentThreadId, identity.threadId)) {
      const inherited = this.get(identity.threadId);
      if (inherited) return {
        cwd: inherited.cwd,
        roots: inherited.roots,
        writableRoots: inherited.writableRoots,
        sandboxPolicy: inherited.sandboxPolicy,
        tools: effectiveChatGptToolPolicy(parsed).tools,
      };
    }
    if (!lineage) throw missingEnvironment;
    const parent = this.get(lineage.parentThreadId);
    if (!parent) throw missingEnvironment;
    if (lineage.sandboxType !== parent.sandboxPolicy.type) {
      throw new Error("ChatGPT Web subagent sandbox metadata conflicts with its trusted parent thread");
    }
    if (lineage.workspaceRoots.length > 0 && !lineage.workspaceRoots.some(root => contains(root, parent.cwd))) {
      throw new Error("ChatGPT Web subagent workspace metadata does not contain its trusted parent cwd");
    }
    if (lineage.workspaceRoots.some(root => !parent.roots.some(parentRoot => (
      contains(parentRoot, root) || contains(root, parentRoot)
    )))) {
      throw new Error("ChatGPT Web subagent workspace metadata conflicts with its trusted parent roots");
    }
    const inherited: ChatGptTurnEnvironment = {
      cwd: parent.cwd,
      roots: parent.roots,
      writableRoots: parent.writableRoots,
      sandboxPolicy: parent.sandboxPolicy,
      tools: effectiveChatGptToolPolicy(parsed).tools,
    };
    this.set(lineage.threadId, inherited);
    return inherited;
  }

  inherit(parentThreadId: string, childThreadId: string): boolean {
    const parent = this.get(parentThreadId);
    if (!parent) return false;
    this.setStored(childThreadId, { ...parent, updatedAt: this.now() });
    return true;
  }

  private get(threadId: string): StoredThreadEnvironment | undefined {
    this.load();
    let stored = this.threads.get(threadId);
    if (!stored) {
      this.load(true);
      stored = this.threads.get(threadId);
    }
    if (!stored) return undefined;
    if (this.now() - stored.updatedAt > THREAD_ENVIRONMENT_TTL_MS) {
      this.threads.delete(threadId);
      this.persist();
      return undefined;
    }
    return stored;
  }

  private set(threadId: string, environment: ChatGptTurnEnvironment): void {
    this.setStored(threadId, authority(environment, this.now()));
  }

  private setStored(threadId: string, environment: StoredThreadEnvironment): void {
    this.load(true);
    this.threads.delete(threadId);
    this.threads.set(threadId, environment);
    while (this.threads.size > MAX_THREAD_ENVIRONMENTS) {
      const oldest = this.threads.keys().next().value as string | undefined;
      if (!oldest) break;
      this.threads.delete(oldest);
    }
    this.persist();
  }

  private load(refresh = false): void {
    if (this.loaded && !refresh) return;
    this.loaded = true;
    if (!this.path || !existsSync(this.path)) return;
    const parsed = JSON.parse(stripUtf8Bom(readFileSync(this.path, "utf8"))) as Partial<StoredThreadEnvironmentFile>;
    const rawThreads = record(parsed.threads);
    if (parsed.version !== 1 || !rawThreads) {
      throw new Error(`Invalid ChatGPT thread environment store: ${this.path}`);
    }
    const cutoff = this.now() - THREAD_ENVIRONMENT_TTL_MS;
    const entries = Object.entries(rawThreads)
      .map(([threadId, value]) => [threadId, validateStoredEnvironment(value)] as const)
      .filter(([, environment]) => environment.updatedAt >= cutoff)
      .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
      .slice(-MAX_THREAD_ENVIRONMENTS);
    for (const [threadId, environment] of entries) {
      const current = this.threads.get(threadId);
      if (!current || current.updatedAt < environment.updatedAt) this.threads.set(threadId, environment);
    }
  }

  private persist(): void {
    if (!this.path) return;
    const payload: StoredThreadEnvironmentFile = {
      version: 1,
      threads: Object.fromEntries(this.threads),
    };
    atomicWriteFile(this.path, `${JSON.stringify(payload, null, 2)}\n`);
  }
}
