import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { atomicWriteFile, stripUtf8Bom } from "../../config";
import { getCodexHome } from "../../codex-integration-shared";
import { isReadableCompactionSummaryText } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import {
  extractChatGptTurnEnvironment,
  extractChatGptCompactionSourceRevision,
  extractChatGptContinuationEnvironmentClaim,
  extractChatGptTurnIdentity,
  extractChatGptThreadSpawnLineage,
  extractChatGptRootThreadMetadata,
  hasCurrentChatGptEnvironmentContext,
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
import { codexTurnMetadataFromBody } from "./environment-identity";
import {
  isUserOrParentInstruction,
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

function contextualEnvelopePart(value: unknown): boolean {
  const part = record(value);
  if ((part?.type !== "input_text" && part?.type !== "text") || typeof part.text !== "string") return false;
  const text = part.text.trim();
  return environmentContextPart(part) || [
    [/^# agents\.md instructions[\s\S]*<instructions>[\s\S]*<\/instructions>$/i, /<\/?instructions>/gi],
    [/^<external_([^>]+)>[\s\S]*<\/external_\1>$/i, /<\/?external_[^>]+>/gi],
    [/^<skill>[\s\S]*<\/skill>$/i, /<\/?skill>/gi],
    [/^<user_shell_command>[\s\S]*<\/user_shell_command>$/i, /<\/?user_shell_command>/gi],
    [/^<turn_aborted>[\s\S]*<\/turn_aborted>$/i, /<\/?turn_aborted>/gi],
    [/^<subagent_notification>[\s\S]*<\/subagent_notification>$/i, /<\/?subagent_notification>/gi],
    [/^<codex_internal_context source="[a-z][a-z0-9_]*">[\s\S]*<\/codex_internal_context>$/i,
      /<\/?codex_internal_context(?:\s+source="[a-z][a-z0-9_]*")?>/gi],
    [/^<goal_context>[\s\S]*<\/goal_context>$/i, /<\/?goal_context>/gi],
    [/^<recommended_plugins>[\s\S]*<\/recommended_plugins>$/i, /<\/?recommended_plugins>/gi],
    [/^<hook_prompt hook_run_id="[^"]+">[\s\S]*<\/hook_prompt>$/i,
      /<\/?hook_prompt(?:\s+hook_run_id="[^"]+")?>/gi],
  ].some(([whole, tags]) => isSingleEnvelope(text, whole!, tags!));
}

function goalContextPart(value: unknown): boolean {
  const part = record(value);
  if ((part?.type !== "input_text" && part?.type !== "text") || typeof part.text !== "string") return false;
  return isSingleEnvelope(
    part.text.trim(),
    /^<codex_internal_context source="goal">[\s\S]*<\/codex_internal_context>$/,
    /<\/?codex_internal_context(?:\s+source="[a-z][a-z0-9_]*")?>/g,
  );
}

function isAcceptedPostCompactionContext(parsed: CodexParsedRequest): boolean {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) return false;
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
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
  if (checkpointIndex < 0) return false;

  const metadata = codexTurnMetadataFromBody(parsed._rawBody);
  const suffix = input.slice(checkpointIndex + 1);
  const hasCurrentSteering = suffix.some(value => {
    const item = record(value);
    const owner = itemTurnId(item);
    return isUserOrParentInstruction(item, metadata)
      && (owner === identity.turnId || (item?.type === "agent_message" && owner === undefined));
  });
  const hasNewEnvironment = suffix.some(value => {
    const item = record(value);
    return (item?.type === "message" || item?.type === "agent_message")
      && /<\/?environment_context\b/i.test(JSON.stringify(item.content ?? ""));
  });
  const suffixUserMessages = suffix.flatMap(value => {
    const item = record(value);
    return item?.type === "message" && item.role === "user" ? [item] : [];
  });
  const goalContextCount = suffixUserMessages.reduce((count, item) => count + (
    Array.isArray(item.content) ? item.content.filter(goalContextPart).length : 0
  ), 0);
  const currentEnvironmentClaimCount = suffixUserMessages.reduce((count, item) => count + (
    Array.isArray(item.content) ? item.content.filter(environmentContextPart).length : 0
  ), 0);
  const goalIndex = suffix.findIndex(value => {
    const item = record(value);
    return item?.type === "message" && item.role === "user"
      && Array.isArray(item.content) && item.content.some(goalContextPart);
  });
  const hasOnlyCurrentContext = suffix.length > 0 && suffix.every((value, index) => {
    const item = record(value);
    if (!item || typeof item.id !== "string" || !item.id || itemTurnId(item) !== identity.turnId) return false;
    // Once the Goal context is established, native output/tool round trips keep the same authority.
    // Output before that boundary, unowned replay and new instructions still fail closed.
    if (goalIndex >= 0 && index > goalIndex) return item.type === "reasoning"
      || item.type === "function_call" || item.type === "function_call_output"
      || (item.type === "message" && item.role === "assistant");
    if (item.type !== "message" || !Array.isArray(item.content) || item.content.length === 0) return false;
    if (item.role === "user") return item.content.every(contextualEnvelopePart);
    return item.role === "developer" && item.content.every(part => {
      const content = record(part);
      return (content?.type === "input_text" || content?.type === "text") && typeof content.text === "string"
        && !/<\/?(?:environment_context|codex_internal_context)\b/i.test(content.text);
    });
  });
  // Goal-driven continuation has no ordinary user revision. Its current, server-owned environment
  // still proceeds only through the canonical rollout comparison in resolve().
  if (!hasCurrentSteering && currentEnvironmentClaimCount === 1 && goalContextCount === 1 && hasOnlyCurrentContext
    && !extractChatGptThreadSpawnLineage(parsed) && extractChatGptRootThreadMetadata(parsed)) return true;
  if (!hasCurrentSteering || hasNewEnvironment) return false;

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
    try {
      const environment = extractChatGptTurnEnvironment(parsed);
      if (identity.threadId) this.set(identity.threadId, environment);
      return environment;
    } catch (error) {
      if (!(error instanceof MissingTrustedCodexEnvironmentError) || !identity.threadId) throw error;
      const hasCurrentContext = hasCurrentChatGptEnvironmentContext(parsed);
      const lineage = extractChatGptThreadSpawnLineage(parsed);
      const currentCompaction = hasCurrentContext && isChatGptCompactionContinuation(parsed);
      const postCompactionContext = hasCurrentContext && !currentCompaction
        && isAcceptedPostCompactionContext(parsed);
      const historicalMessages = hasCurrentContext && !currentCompaction && !postCompactionContext && lineage
        ? unattributedChatGptEnvironmentMessages(parsed) : undefined;
      if (hasCurrentContext && !currentCompaction && !postCompactionContext && !historicalMessages) throw error;
      const currentClaim = currentCompaction || postCompactionContext
        ? extractChatGptContinuationEnvironmentClaim(parsed) : undefined;
      const rolloutIdentity = lineage ?? extractChatGptRootThreadMetadata(parsed);
      // Automatic compaction has a current turn_context; standalone compaction has only its
      // source turn_context. Either must be the latest native record, never an arbitrary ancestor.
      const compactionSourceTurnId = parsed._compactionRequest
        ? extractChatGptCompactionSourceRevision(parsed).turnId : undefined;
      if (rolloutIdentity && identity.turnId) {
        const rolloutEnvironment = resolveCurrentCodexRolloutEnvironment({
          codexHome: this.codexHome,
          ...(this.sqliteHome ? { sqliteHome: this.sqliteHome } : {}),
          lineage: rolloutIdentity,
          turnId: identity.turnId,
          ...(compactionSourceTurnId ? { compactionSourceTurnId } : {}),
          ...(historicalMessages ? { historicalEnvironmentMessages: historicalMessages } : {}),
          tools: effectiveChatGptToolPolicy(parsed).tools,
        });
        if (rolloutEnvironment) {
          if (currentClaim && !sameAuthority(currentClaim, rolloutEnvironment)) {
            throw new Error("Compaction continuation environment conflicts with its current Codex rollout");
          }
          this.set(rolloutIdentity.threadId, rolloutEnvironment);
          return rolloutEnvironment;
        }
      }
      // Only a current native rollout can supersede an unrecognized historical envelope. Without
      // that proof, do not turn arbitrary history or an invalid update into cached authority.
      if (hasRawChatGptEnvironmentContext(parsed)) throw error;
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
      if (!lineage) throw error;
      const parent = this.get(lineage.parentThreadId);
      if (!parent) throw error;
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
