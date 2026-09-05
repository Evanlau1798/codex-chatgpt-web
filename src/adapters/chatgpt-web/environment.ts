import { isAbsolute, resolve } from "node:path";
import type { CodexContentPart, CodexParsedRequest, CodexTool } from "../../types";
import { isContextualCodexUserMessage } from "./contextual-user-message";
import { effectiveChatGptToolPolicy } from "./tool-policy";
import { currentTurnUserRevision, priorAbortedTurnIds } from "./turn-user-revision";
import { isAcceptedCompactionContinuation } from "./compaction-continuation";
import { isReadableCompactionSummaryText, OPAQUE_COMPACTION_NOTE } from "../../responses/compaction";
import {
  codexTurnMetadataFromBody,
  extractChatGptTurnIdentity,
  canonicalSandboxMetadata,
  sandboxTypeFromMetadata,
} from "./environment-identity";
import {
  decodeXmlText,
  environmentCwdMatches,
  isCurrentThreadVisualizationRoot,
  matchesPath,
  MissingTrustedCodexEnvironmentError,
  pathIdentity,
  uniqueAbsolutePaths,
} from "./environment-paths";
export { MissingTrustedCodexEnvironmentError } from "./environment-paths";
export {
  extractChatGptTurnIdentity,
  extractCodexTurnIdentityFromBody,
  type ChatGptTurnIdentity,
  type ChatGptThreadSpawnLineage,
  type ChatGptRootThreadMetadata,
  extractChatGptThreadSpawnLineage,
  extractChatGptRootThreadMetadata,
} from "./environment-identity";
export type ChatGptSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "workspaceWrite"; writableRoots: string[]; networkAccess: boolean };
export interface ChatGptTurnEnvironment {
  cwd: string;
  roots: string[];
  writableRoots: string[];
  sandboxPolicy: ChatGptSandboxPolicy;
  tools: CodexTool[];
}
export interface ChatGptTurnUserRevision {
  content: unknown;
  turnId?: string;
}

export const CHATGPT_TURN_REVISION_CONFLICT_MESSAGE =
  "ChatGPT web current user message conflicts with native Codex turn_id metadata";
function contentText(content: string | CodexContentPart[]): string {
  if (typeof content === "string") return content;
  return content.filter(part => part.type === "text").map(part => part.text).join("\n");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function clientTurnMetadata(parsed: CodexParsedRequest): Record<string, unknown> | undefined {
  return codexTurnMetadataFromBody(parsed._rawBody);
}

function itemTurnId(value: unknown): string | undefined {
  const turnId = record(record(value)?.internal_chat_message_metadata_passthrough)?.turn_id;
  return typeof turnId === "string" ? turnId : undefined;
}

function rawMessageText(value: Record<string, unknown>): string {
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return "";
  return value.content
    .map(part => record(part)?.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

/** True when the raw Responses input attempted to carry an environment envelope, valid or not. */
export function hasRawChatGptEnvironmentContext(parsed: CodexParsedRequest): boolean {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  return input.some(value => {
    const item = record(value);
    return item?.type === "message" && /<\/?environment_context\b/i.test(rawMessageText(item));
  });
}

/** Historical XML is not a current environment update, including in old untagged rollouts. */
export function hasCurrentChatGptEnvironmentContext(parsed: CodexParsedRequest): boolean {
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  if (!turnId) return hasRawChatGptEnvironmentContext(parsed);
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  let laterAssistantOutput = false;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = record(input[index]);
    if (!item) continue;
    if ((item.type === "message" && item.role === "assistant")
      || item.type === "function_call" || item.type === "reasoning" || item.type === "compaction") {
      laterAssistantOutput = true;
    }
    if (item.type !== "message" || !/<\/?environment_context\b/i.test(rawMessageText(item))) continue;
    const owner = itemTurnId(item);
    if (owner === turnId || (owner === undefined && !laterAssistantOutput)) return true;
  }
  return false;
}

function contextualUserMessage(value: Record<string, unknown>): boolean {
  const text = rawMessageText(value).trim();
  return /^<environment_context>[\s\S]*<\/environment_context>$/.test(text)
    || /^<subagent_notification>[\s\S]*<\/subagent_notification>$/.test(text)
    || isReadableCompactionSummaryText(text)
    || text === OPAQUE_COMPACTION_NOTE;
}
/** Current native instruction, or an exact daemon-proven checkpoint continuation. */
export function extractChatGptTurnUserRevision(parsed: CodexParsedRequest): unknown {
  const identity = extractChatGptTurnIdentity(parsed);
  const turnId = identity.turnId;
  if (!turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  const revision = isChatGptCompactionContinuation(parsed)
    ? latestChatGptTurnUserRevision(parsed) : currentTurnUserRevision(parsed._rawBody, turnId);
  if (!revision) throw new Error("ChatGPT web requires a current-turn user message for browser-session replay");
  if (revision.turnId !== undefined && revision.turnId !== turnId
    && (priorAbortedTurnIds(parsed._rawBody, turnId).includes(revision.turnId)
      || !isAcceptedCompactionContinuation(parsed, identity, revision))) {
    throw new Error(CHATGPT_TURN_REVISION_CONFLICT_MESSAGE);
  }
  return revision.content;
}

export function extractChatGptTurnUserText(parsed: CodexParsedRequest): string | undefined {
  const content = extractChatGptTurnUserRevision(parsed);
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap(part => {
    const value = record(part);
    return (value?.type === "input_text" || value?.type === "text") && typeof value.text === "string"
      ? [value.text]
      : [];
  }).join("\n");
  return text || undefined;
}

function latestChatGptTurnUserRevision(parsed: CodexParsedRequest): ChatGptTurnUserRevision | undefined {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = record(input[index]);
    const ordinaryUser = item?.type === "message" && item.role === "user";
    if (!ordinaryUser && item?.type !== "agent_message") continue;
    if (isContextualCodexUserMessage(item.content)) continue;
    const messageTurnId = itemTurnId(item);
    const serverOwnedId = typeof item.id === "string" && item.id.length > 0;
    if (messageTurnId === undefined && !serverOwnedId) continue;
    return { content: item.content, ...(messageTurnId ? { turnId: messageTurnId } : {}) };
  }
  return undefined;
}

/** The human instruction summarized by a remote compaction request belongs to an earlier turn. */
export function extractChatGptCompactionSourceRevision(parsed: CodexParsedRequest): ChatGptTurnUserRevision {
  if (!parsed._compactionRequest) throw new Error("ChatGPT web compaction source requires a compaction request");
  const revision = latestChatGptTurnUserRevision(parsed);
  if (!revision) throw new Error("ChatGPT web compaction requires a source user message");
  return revision;
}

/** A completed checkpoint binds an older instruction to this exact continuing native turn. */
export function isChatGptCompactionContinuation(parsed: CodexParsedRequest): boolean {
  const identity = extractChatGptTurnIdentity(parsed);
  const revision = latestChatGptTurnUserRevision(parsed);
  return revision?.turnId !== undefined && identity.turnId !== undefined
    && revision.turnId !== identity.turnId
    && !priorAbortedTurnIds(parsed._rawBody, identity.turnId ?? "").includes(revision.turnId)
    && isAcceptedCompactionContinuation(parsed, identity, revision);
}

/** Parse a claim only: the caller must compare it with this turn's native rollout authority. */
export function extractChatGptContinuationEnvironmentClaim(parsed: CodexParsedRequest): ChatGptTurnEnvironment {
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  const body = record(parsed._rawBody);
  const updates = (Array.isArray(body?.input) ? body.input : []).flatMap(value => {
    const item = record(value);
    if (item?.type !== "message" || item.role !== "user" || itemTurnId(item) !== turnId
      || typeof item.id !== "string" || !item.id) return [];
    const text = rawMessageText(item).trim();
    return /^<environment_context>[\s\S]*<\/environment_context>$/.test(text) ? [text] : [];
  });
  if (updates.length !== 1) throw new Error("Compaction continuation requires one current native environment claim");
  return parseChatGptEnvironmentText(parsed, updates[0]!);
}

function environmentBeforeUser(input: unknown[], userIndex: number, expectedTurnId?: string): string | undefined {
  if (userIndex <= 0) return undefined;
  const user = record(input[userIndex]);
  if (user?.type !== "message" || user.role !== "user") return undefined;

  const userTurnId = itemTurnId(user);
  if (!userTurnId || (expectedTurnId && userTurnId !== expectedTurnId)) return undefined;

  let candidateIndex = userIndex - 1;
  let candidate = record(input[candidateIndex]);
  while (candidate?.type === "message" && candidate.role === "developer") {
    const developerTurnId = itemTurnId(candidate);
    if (developerTurnId !== userTurnId) return undefined;
    candidateIndex -= 1;
    candidate = record(input[candidateIndex]);
  }
  if (candidate?.type !== "message" || candidate.role !== "user") return undefined;

  const candidateTurnId = itemTurnId(candidate);
  if (candidateTurnId !== userTurnId) return undefined;

  const content = Array.isArray(candidate.content) ? candidate.content : [];
  for (const part of content) {
    const text = record(part)?.text;
    if (typeof text !== "string") continue;
    const trimmed = text.trim();
    if (/^<environment_context>[\s\S]*<\/environment_context>$/.test(trimmed)) return trimmed;
  }
  return undefined;
}

function sandboxTypeFromEnvironment(text: string): ChatGptSandboxPolicy["type"] | undefined {
  const unrestricted = /<permission_profile\s+type=["']disabled["'][^>]*>[\s\S]*?<file_system\s+type=["']unrestricted["'][^>]*\/?\s*>/i.test(text)
    || /<sandbox_mode>danger-full-access<\/sandbox_mode>/i.test(text);
  const restrictedFileSystem = /<permission_profile\s+type=["']managed["'][^>]*>[\s\S]*?<file_system\s+type=["']restricted["'][^>]*>([\s\S]*?)<\/file_system>/i.exec(text);
  const restrictedHasWriteEntry = restrictedFileSystem !== null
    && /<entry\s+access=["']write["'][^>]*>/i.test(restrictedFileSystem[1]!);
  const workspaceWrite = /<sandbox_mode>workspace-write<\/sandbox_mode>/i.test(text)
    || restrictedHasWriteEntry;
  const readOnly = /<sandbox_mode>read-only<\/sandbox_mode>/i.test(text)
    || (restrictedFileSystem !== null && !restrictedHasWriteEntry);
  if (Number(unrestricted) + Number(workspaceWrite) + Number(readOnly) !== 1) return undefined;
  return unrestricted ? "dangerFullAccess" : workspaceWrite ? "workspaceWrite" : "readOnly";
}

function sandboxMetadataMatchesEnvironment(
  metadataValue: unknown,
  environmentText: string,
): boolean {
  const metadataSandbox = sandboxTypeFromMetadata(metadataValue);
  const environmentSandbox = sandboxTypeFromEnvironment(environmentText);
  if (!metadataSandbox || !environmentSandbox) return false;
  if (metadataSandbox === "platform") {
    return environmentSandbox === "workspaceWrite" || environmentSandbox === "readOnly";
  }
  return metadataSandbox === environmentSandbox;
}

function environmentMatchesCanonicalMetadata(
  environmentText: string,
  metadata: Record<string, unknown>,
  requireMetadataBoundRoots: boolean,
): boolean {
  const metadataSandboxValue = canonicalSandboxMetadata(metadata);
  const metadataSandbox = sandboxTypeFromMetadata(metadataSandboxValue);
  if (!metadataSandbox) return false;
  const workspaces = record(metadata.workspaces);
  const metadataRoots = workspaces ? Object.keys(workspaces) : [];
  if (metadataRoots.some(path => !isAbsolute(path))) return false;
  const normalizedMetadataRoots = [...new Set(metadataRoots.map(pathIdentity))];

  let cwdMatches: string[];
  try {
    cwdMatches = environmentCwdMatches(environmentText, normalizedMetadataRoots)
      .map(value => decodeXmlText(value.trim()));
  } catch {
    return false;
  }
  if (cwdMatches.length !== 1 || !isAbsolute(cwdMatches[0]!)) return false;
  const rootMatches = [...environmentText.matchAll(/<workspace_roots>[\s\S]*?<\/workspace_roots>/g)]
    .flatMap(section => [...section[0].matchAll(/<root>([^<]+)<\/root>/g)].map(match => decodeXmlText(match[1]!.trim())));
  const declaredRootValues = rootMatches.length > 0 ? rootMatches : cwdMatches;
  if (declaredRootValues.some(path => !isAbsolute(path))) return false;
  const declaredRoots = [...new Set(declaredRootValues.map(pathIdentity))];
  const cwd = pathIdentity(cwdMatches[0]!);
  if (normalizedMetadataRoots.length > 0
    && !normalizedMetadataRoots.some(root => matchesPath(root, cwd))) return false;
  if (requireMetadataBoundRoots && (
    normalizedMetadataRoots.length === 0
    || declaredRoots.some(root => (
      !normalizedMetadataRoots.some(metadataRoot => matchesPath(metadataRoot, root))
      && !isCurrentThreadVisualizationRoot(root, metadata)
    ))
  )) return false;
  if (!declaredRoots.some(root => matchesPath(root, cwd))) return false;
  return sandboxMetadataMatchesEnvironment(metadataSandboxValue, environmentText);
}

function canonicalMetadataEnvironmentBeforeUser(
  input: unknown[],
  userIndex: number,
  metadata: Record<string, unknown> | undefined,
  requireMetadataBoundRoots = false,
): string | undefined {
  if (userIndex <= 0 || !metadata) return undefined;
  const metadataTurnId = typeof metadata.turn_id === "string" ? metadata.turn_id.trim() : "";
  const metadataSandbox = sandboxTypeFromMetadata(canonicalSandboxMetadata(metadata));
  if (!metadataTurnId || !metadataSandbox) return undefined;

  const user = record(input[userIndex]);
  if (user?.type !== "message" || user.role !== "user" || typeof user.id !== "string" || !user.id) return undefined;
  const userTurnId = itemTurnId(user);
  if (userTurnId !== undefined && userTurnId !== metadataTurnId) return undefined;

  let candidateIndex = userIndex - 1;
  let candidate = record(input[candidateIndex]);
  while (candidate?.type === "message" && candidate.role === "developer") {
    const developerTurnId = itemTurnId(candidate);
    const serverOwnedId = typeof candidate.id === "string" && candidate.id.length > 0;
    if (developerTurnId === undefined ? !serverOwnedId : developerTurnId !== metadataTurnId) return undefined;
    candidateIndex -= 1;
    candidate = record(input[candidateIndex]);
  }
  if (candidate?.type !== "message" || candidate.role !== "user" || typeof candidate.id !== "string" || !candidate.id) return undefined;
  const candidateTurnId = itemTurnId(candidate);
  if (candidateTurnId !== undefined && candidateTurnId !== metadataTurnId) return undefined;

  const content = Array.isArray(candidate.content) ? candidate.content : [];
  for (const part of content) {
    const text = record(part)?.text;
    if (typeof text !== "string") continue;
    const trimmed = text.trim();
    if (!/^<environment_context>[\s\S]*<\/environment_context>$/.test(trimmed)) continue;
    // Current Codex stamps server-owned item IDs but not per-item turn IDs on the initial request,
    // and canonical workspaces contains Git enrichment rather than filesystem authority. Bind the
    // structurally adjacent context (allowing only provenance-checked developer messages) to
    // canonical turn/sandbox metadata; when Git roots are present, require the primary cwd to agree
    // with them as an additional check.
    if (!environmentMatchesCanonicalMetadata(trimmed, metadata, requireMetadataBoundRoots)) continue;
    return trimmed;
  }
  return undefined;
}

function hasAssistantOutputBetween(input: unknown[], startIndex: number, endIndex: number): boolean {
  for (let index = startIndex; index < endIndex; index += 1) {
    const item = record(input[index]);
    if (!item) continue;
    if (item.type === "message" && item.role === "assistant") return true;
    if (item.type === "function_call" || item.type === "reasoning") return true;
  }
  return false;
}

function rawEnvironmentText(parsed: CodexParsedRequest): string | undefined {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  let activeUserIndex = -1;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = record(input[index]);
    if (item?.role === "user" && !contextualUserMessage(item)) {
      activeUserIndex = index;
      break;
    }
  }
  const turnId = clientTurnMetadata(parsed)?.turn_id;
  const currentByTurn = environmentBeforeUser(
    input,
    activeUserIndex,
    typeof turnId === "string" ? turnId : undefined,
  );
  if (currentByTurn) return currentByTurn;

  const current = canonicalMetadataEnvironmentBeforeUser(input, activeUserIndex, clientTurnMetadata(parsed));
  if (current) return current;

  // Native steering appends same-turn user items without repeating the trusted envelope. Reuse
  // only an explicitly turn-owned pair, and never skip a newer environment attempt or provenance gap.
  if (typeof turnId === "string") {
    for (let index = activeUserIndex - 1; index > 0; index -= 1) {
      const following = record(input[index + 1]);
      if (following?.type !== "message" || following.role !== "user" || itemTurnId(following) !== turnId
        || /<\/?environment_context\b/i.test(rawMessageText(following))) break;
      const earlier = environmentBeforeUser(input, index, turnId);
      const metadata = clientTurnMetadata(parsed);
      if (earlier && (metadata?.workspaces === undefined || environmentMatchesCanonicalMetadata(earlier, metadata, true))) return earlier;
    }
  }

  // A skill invocation appends another server-owned user item after the real instruction. Recover
  // the earlier current-turn environment/prompt pair only through canonical metadata, and bind all
  // declared roots to metadata workspaces so user-authored XML cannot widen filesystem authority.
  const metadata = clientTurnMetadata(parsed);
  let crossedAssistantOutput = false;
  for (let index = activeUserIndex - 1; index > 0; index -= 1) {
    crossedAssistantOutput ||= hasAssistantOutputBetween(input, index, index + 1);
    if (crossedAssistantOutput && itemTurnId(input[index]) !== turnId) continue;
    const sameTurn = canonicalMetadataEnvironmentBeforeUser(input, index, metadata, true);
    if (sameTurn) return sameTurn;
  }

  if (hasCurrentChatGptEnvironmentContext(parsed)) return undefined;

  const replayPrefixLen = Math.min(parsed._replayPrefixLen ?? 0, input.length);
  for (let index = replayPrefixLen - 1; index > 0; index -= 1) {
    const replayed = environmentBeforeUser(input, index);
    if (replayed) return replayed;
  }

  // Native transcript replay needs a matching historical pair and assistant boundary, or
  // server-owned provenance whose authority still matches current workspace/sandbox metadata.
  const currentTurnId = typeof turnId === "string" ? turnId : undefined;
  const currentThreadId = typeof metadata?.thread_id === "string" && metadata.thread_id.trim()
    ? metadata.thread_id
    : undefined;
  const activeUser = record(input[activeUserIndex]);
  const activeUserOwned = activeUser?.type === "message"
    && activeUser.role === "user"
    && typeof activeUser.id === "string"
    && activeUser.id.length > 0
    && itemTurnId(activeUser) === currentTurnId;
  if (currentTurnId && itemTurnId(activeUser) === currentTurnId) {
    for (let index = activeUserIndex - 1; index > 0; index -= 1) {
      const historicalUser = record(input[index]);
      const historicalTurnId = itemTurnId(historicalUser);
      if (!historicalTurnId || historicalTurnId === currentTurnId) continue;
      const historical = environmentBeforeUser(input, index);
      if (!historical) continue;
      if (hasAssistantOutputBetween(input, index + 1, activeUserIndex)) return historical;
      if (!currentThreadId || !metadata || !activeUserOwned) continue;
      const bounded = canonicalMetadataEnvironmentBeforeUser(
        input,
        index,
        { ...metadata, turn_id: historicalTurnId, sandbox: canonicalSandboxMetadata(metadata) },
        true,
      );
      if (bounded === historical) return bounded;
    }
  }
  return undefined;
}

function clientMetadataWorkspaceRoots(parsed: CodexParsedRequest): string[] {
  const workspaces = record(clientTurnMetadata(parsed)?.workspaces);
  if (!workspaces) return [];
  const roots = Object.keys(workspaces);
  if (roots.some(path => !isAbsolute(path))) return [];
  return [...new Set(roots.map(pathIdentity))];
}

function trustedEnvironmentText(parsed: CodexParsedRequest): string {
  const raw = rawEnvironmentText(parsed);
  if (raw) return raw;
  // A real Responses request always has `_rawBody`. Parsed system/developer text has already lost
  // the wire provenance needed to distinguish Codex context from user-authored XML, so it must
  // never become filesystem authority for a raw request.
  if (parsed._rawBody !== undefined) return "";
  const system = parsed.context.systemPrompt ?? [];
  const developer = parsed.context.messages
    .filter(message => message.role === "developer")
    .map(message => contentText(message.content));
  return [...system, ...developer].join("\n");
}

export function extractChatGptTurnEnvironment(parsed: CodexParsedRequest): ChatGptTurnEnvironment {
  return parseChatGptEnvironmentText(parsed, trustedEnvironmentText(parsed));
}

function parseChatGptEnvironmentText(parsed: CodexParsedRequest, text: string): ChatGptTurnEnvironment {
  const cwdMatches = environmentCwdMatches(text, clientMetadataWorkspaceRoots(parsed));
  const cwdCandidates = uniqueAbsolutePaths(cwdMatches, "cwd");
  if (cwdCandidates.length !== 1) throw new Error("ChatGPT web turn has conflicting trusted Codex cwd values");
  const cwd = cwdCandidates[0]!;

  const rootMatches = [...text.matchAll(/<workspace_roots>[\s\S]*?<\/workspace_roots>/g)]
    .flatMap(section => [...section[0].matchAll(/<root>([^<]+)<\/root>/g)].map(match => match[1] ?? ""));
  const roots = rootMatches.length > 0 ? uniqueAbsolutePaths(rootMatches, "workspace_roots") : [cwd];
  if (!roots.some(root => matchesPath(root, cwd))) {
    throw new Error("ChatGPT web cwd is outside the trusted Codex workspace roots");
  }

  const sandboxType = sandboxTypeFromEnvironment(text);
  const networkAccess = /<network_access>enabled<\/network_access>/i.test(text) || /network access is enabled/i.test(text);
  const tools = effectiveChatGptToolPolicy(parsed).tools;

  if (!sandboxType) {
    throw new Error("ChatGPT web turn requires one explicit trusted Codex sandbox mode");
  }
  if (sandboxType === "dangerFullAccess") {
    return { cwd, roots, writableRoots: roots, sandboxPolicy: { type: "dangerFullAccess" }, tools };
  }
  if (sandboxType === "workspaceWrite") {
    return {
      cwd,
      roots,
      writableRoots: roots,
      sandboxPolicy: { type: "workspaceWrite", writableRoots: roots, networkAccess },
      tools,
    };
  }
  return { cwd, roots, writableRoots: [], sandboxPolicy: { type: "readOnly", networkAccess }, tools };
}
