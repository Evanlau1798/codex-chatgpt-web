import { isAbsolute, resolve } from "node:path";
import { isReadableCompactionSummaryText, OPAQUE_COMPACTION_NOTE } from "../../responses/compaction";
import type { CodexContentPart, CodexParsedRequest, CodexTool } from "../../types";
import { effectiveChatGptToolPolicy } from "./tool-policy";
import {
  currentTurnUserRevision,
  isCurrentTurnInstruction,
  isNativeInstruction,
  isTurnAbortedNotice,
  itemTurnId,
  priorAbortedTurnIds,
  turnUserRevisionHistory,
} from "./turn-user-revision";
import { hasEnvironmentContextFragment, hasEnvironmentContextAttempt, isPureContextualCodexUserText } from "./contextual-user-message";
import { isAcceptedCompactionContinuation, recoverCompactionInstruction } from "./compaction-continuation";
import {
  codexTurnMetadataFromBody,
  extractChatGptTurnIdentity,
  canonicalSandboxMetadata,
  sandboxTypeFromMetadata,
} from "./environment-identity";
import {
  decodeXmlText,
  environmentCwdMatches,
  isCurrentOrParentThreadVisualizationRoot,
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
  itemId?: string;
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
    return hasEnvironmentContextFragment(item);
  });
}

function currentEnvironmentAttempts(parsed: CodexParsedRequest): Array<{ item: Record<string, unknown>; index: number }> {
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  if (!turnId) return [];
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const metadata = clientTurnMetadata(parsed);
  const replayPrefixLen = Math.min(parsed._replayPrefixLen ?? 0, input.length);
  const revisionId = currentTurnUserRevision(parsed._rawBody, turnId)?.itemId;
  const revisionIndex = revisionId
    ? input.findLastIndex(value => record(value)?.id === revisionId)
    : -1;
  const currentInstructions: number[] = [];
  for (let index = replayPrefixLen; index < input.length; index += 1) {
    const item = record(input[index]);
    if (isCurrentTurnInstruction(item, metadata, turnId) || index === revisionIndex) currentInstructions.push(index);
  }
  const structurallyFollowedByCurrentContext = (index: number): boolean => {
    for (let next = index + 1; next < input.length; next += 1) {
      const item = record(input[next]);
      if (!item) return false;
      if (item.type === "message" && item.role === "developer") continue;
      return isCurrentTurnInstruction(item, metadata, turnId) || next === revisionIndex;
    }
    return false;
  };
  return input.flatMap((value, index) => {
    if (index < replayPrefixLen) return [];
    const item = record(value);
    if (!hasEnvironmentContextFragment(item)) return [];
    const owner = itemTurnId(item);
    const current = owner === turnId
      || currentInstructions.some(instruction => instruction < index)
      || structurallyFollowedByCurrentContext(index);
    return current ? [{ item, index }] : [];
  });
}

/** Historical XML is not a current environment update, including in old untagged rollouts. */
export function hasCurrentChatGptEnvironmentContext(parsed: CodexParsedRequest): boolean {
  return extractChatGptTurnIdentity(parsed).turnId
    ? currentEnvironmentAttempts(parsed).length > 0
    : hasRawChatGptEnvironmentContext(parsed);
}

/** Current native instruction, or an exact daemon-proven checkpoint continuation. */
export function extractChatGptTurnUserRevision(parsed: CodexParsedRequest): unknown {
  const identity = extractChatGptTurnIdentity(parsed);
  const turnId = identity.turnId;
  if (!turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  const current = currentTurnUserRevision(parsed._rawBody, turnId);
  const input = record(parsed._rawBody)?.input;
  const summaryOnly = turnUserRevisionHistory(parsed._rawBody).length === 0
    && !isTurnAbortedNotice(current?.content) && Array.isArray(input) && input.some(value => {
      const item = record(value);
      return item && (compactionSummaryMessage(item)
        || ["compaction", "compaction_summary", "context_compaction"].includes(String(item.type)));
    });
  // A summary is not a new instruction. Only this daemon's matching completed checkpoint
  // can recover the source when native compaction removes it, including within the same turn.
  const revision = summaryOnly ? recoverCompactionInstruction(parsed, identity)?.source
    : isChatGptCompactionContinuation(parsed) ? latestChatGptTurnUserRevision(parsed) : current;
  if (!revision || (revision === current && hasEnvironmentContextAttempt(revision.content))) {
    throw new Error("ChatGPT web requires a current-turn user message for browser-session replay");
  }
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
  return turnUserRevisionHistory(parsed._rawBody).at(-1)
    ?? recoverCompactionInstruction(parsed, extractChatGptTurnIdentity(parsed))?.source;
}

export function chatGptTurnUserRevisionHistory(parsed: CodexParsedRequest): ChatGptTurnUserRevision[] {
  const revisions = turnUserRevisionHistory(parsed._rawBody);
  const recovered = revisions.length === 0 ? recoverCompactionInstruction(parsed, extractChatGptTurnIdentity(parsed)) : undefined;
  return recovered ? [recovered.source] : revisions;
}

/** The instruction summarized by a compaction request may belong to its source turn. */
export function extractChatGptCompactionSourceRevision(parsed: CodexParsedRequest): ChatGptTurnUserRevision {
  if (!parsed._compactionRequest && !parsed._localCompactionRequest) {
    throw new Error("ChatGPT web compaction source requires a compaction request");
  }
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

const CALENDAR_ENVIRONMENT_DELTA = /^<environment_context>\s*<current_date>\d{4}-\d{2}-\d{2}<\/current_date>\s*(?:<timezone>[^<>]+<\/timezone>\s*)?<filesystem>\s*<permission_profile type="disabled">\s*<file_system type="unrestricted"\s*\/>\s*<\/permission_profile>\s*<\/filesystem>\s*<\/environment_context>$/;

/** Parse a claim only: the caller must compare it with this turn's native rollout authority. */
export function extractChatGptContinuationEnvironmentClaims(
  parsed: CodexParsedRequest, provenCalendarDelta = false,
): ChatGptTurnEnvironment[] {
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const metadata = clientTurnMetadata(parsed);
  const revisionId = turnId ? currentTurnUserRevision(parsed._rawBody, turnId)?.itemId : undefined;
  const revisionIndex = revisionId
    ? input.findLastIndex(value => record(value)?.id === revisionId)
    : -1;
  const currentInstructions: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const item = record(input[index]);
    if (isCurrentTurnInstruction(item, metadata, turnId ?? "") || index === revisionIndex) currentInstructions.push(index);
  }
  const updates = currentEnvironmentAttempts(parsed).flatMap(({ item, index }) => {
    if (provenCalendarDelta && CALENDAR_ENVIRONMENT_DELTA.test(rawMessageText(item).trim())) return [];
    if (item.role !== "user") {
      throw new Error("Compaction continuation contains an unowned current native environment claim");
    }
    const owner = itemTurnId(item);
    const afterCurrentInstruction = currentInstructions.some(instruction => instruction < index);
    const parts = typeof item.content === "string" ? [item.content]
      : Array.isArray(item.content) ? item.content.map(part => record(part)?.text) : [];
    const serverOwnedId = typeof item.id === "string" && !!item.id;
    const idlessSingleContextRefresh = !serverOwnedId && owner === undefined && parts.length === 1
      && typeof parts[0] === "string" && isPureContextualCodexUserText(parts[0]);
    if (!serverOwnedId && !idlessSingleContextRefresh) {
      throw new Error("Compaction continuation contains an unowned current native environment claim");
    }
    const pureContextBundle = parts.length > 1 && parts.every(value => (
      typeof value === "string" && isPureContextualCodexUserText(value)
    ));
    if (owner === undefined && serverOwnedId && !pureContextBundle) {
      throw new MissingTrustedCodexEnvironmentError("cwd");
    }
    if (owner !== undefined && owner !== turnId) {
      throw new Error("Compaction continuation contains an environment claim owned by another native turn");
    }
    if ((afterCurrentInstruction || owner === undefined) && parts.some(value => (
      typeof value !== "string" || !isPureContextualCodexUserText(value)
    ))) {
      throw new Error("Compaction continuation mixes a current native environment refresh with other content");
    }
    return parts.filter((value): value is string => (
      typeof value === "string" && hasEnvironmentContextAttempt(value)
    ));
  });
  if (updates.length === 0 && !provenCalendarDelta) throw new Error("Compaction continuation requires a current native environment claim");
  return updates.map(text => {
    const update = text.trim();
    if (!/^<environment_context>[\s\S]*<\/environment_context>$/.test(update)) {
      throw new Error("Compaction continuation contains a malformed current native environment claim");
    }
    return parseChatGptEnvironmentText(parsed, update);
  });
}

/**
 * Steering can separate the original environment/instruction pair from the active instruction.
 * Git workspace metadata need not list every native filesystem root. Return that earlier claim
 * only for a same-turn pair; the store must compare it with the current canonical rollout.
 */
export function extractChatGptSteeringEnvironmentClaim(parsed: CodexParsedRequest): ChatGptTurnEnvironment | undefined {
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  if (!turnId) return undefined;
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const metadata = clientTurnMetadata(parsed);
  const activeIndex = input.findLastIndex(value => isNativeInstruction(record(value), metadata));
  const active = record(input[activeIndex]);
  if (itemTurnId(active) !== turnId || typeof active?.id !== "string" || !active.id) return undefined;

  // Do not skip an unrecognized update or use one of several competing envelopes. Older,
  // explicitly attributed history is not a current claim; untagged XML remains unproven.
  const claims = input.flatMap((value, index) => {
    const item = record(value);
    if (!hasEnvironmentContextFragment(item)) return [];
    const owner = itemTurnId(item);
    return owner === undefined || owner === turnId ? [{ item, index }] : [];
  });
  if (claims.length !== 1) return undefined;
  const claim = claims[0]!;
  if (claim.item.role !== "user" || itemTurnId(claim.item) !== turnId
    || typeof claim.item.id !== "string" || !claim.item.id) return undefined;
  const parts = Array.isArray(claim.item.content) ? claim.item.content : [];
  if (parts.filter(part => /<\/?environment_context\b/i.test(String(record(part)?.text ?? ""))).length !== 1) return undefined;

  for (let index = claim.index + 1; index < activeIndex; index += 1) {
    const instruction = record(input[index]);
    if (typeof instruction?.id !== "string" || !instruction.id) continue;
    const text = environmentBeforeUser(input, index, turnId, metadata);
    if (text) return parseChatGptEnvironmentText(parsed, text);
  }
  return undefined;
}

/**
 * Native world-state diffs omit unchanged cwd/shell at midnight but repeat the filesystem
 * profile. Recognize the observed unrestricted calendar fragment as a claim only: the store
 * still requires this exact turn's native rollout and corroborating current sandbox metadata.
 * Unknown profiles/fields are deliberately not classified as permission-neutral updates.
 */
export function hasChatGptCalendarEnvironmentDelta(parsed: CodexParsedRequest): boolean {
  const metadata = clientTurnMetadata(parsed);
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  if (!metadata || !turnId) return false;
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const activeIndex = input.findLastIndex(value => isNativeInstruction(record(value), metadata));
  const active = record(input[activeIndex]);
  if (itemTurnId(active) !== turnId || typeof active?.id !== "string" || !active.id) return false;

  let deltas = 0;
  for (let index = activeIndex + 1; index < input.length; index += 1) {
    const item = record(input[index]);
    if (!hasEnvironmentContextFragment(item)) continue;
    if (item.role !== "user" || itemTurnId(item) !== turnId || typeof item.id !== "string" || !item.id
      || !hasAssistantOutputBetween(input, activeIndex + 1, index)) return false;
    const text = rawMessageText(item).trim();
    // Match the whole native fragment, not just the presence of a disabled profile: another
    // profile, a malformed cwd, or any additional permission declaration must fail closed.
    if (!CALENDAR_ENVIRONMENT_DELTA.test(text)
      || !sandboxMetadataMatchesEnvironment(canonicalSandboxMetadata(metadata), text)
      || [metadata.sandbox_mode, metadata.sandbox].some(value => (
        value !== undefined && !sandboxMetadataMatchesEnvironment(value, text)
      ))) return false;
    deltas += 1;
  }
  return deltas > 0;
}

function environmentBeforeUser(input: unknown[], userIndex: number, expectedTurnId?: string, metadata?: Record<string, unknown>): string | undefined {
  if (userIndex <= 0) return undefined;
  const user = record(input[userIndex]);
  if (!isNativeInstruction(user, metadata)) return undefined;

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
      && !isCurrentOrParentThreadVisualizationRoot(root, metadata)
    ))
  )) return false;
  if (!declaredRoots.some(root => matchesPath(root, cwd))) return false;
  return sandboxMetadataMatchesEnvironment(metadataSandboxValue, environmentText);
}

function compactionSummaryMessage(value: Record<string, unknown>): boolean {
  if (value.type !== "message" || value.role !== "user") return false;
  const text = rawMessageText(value).trim();
  return isReadableCompactionSummaryText(text) || text === OPAQUE_COMPACTION_NOTE;
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
  if (!isNativeInstruction(user, metadata) || typeof user.id !== "string" || !user.id) return undefined;
  const userTurnId = itemTurnId(user);
  if (userTurnId !== undefined && userTurnId !== metadataTurnId) return undefined;

  return canonicalMetadataEnvironmentBefore(input, userIndex, metadata, requireMetadataBoundRoots);
}

/** Read an envelope before a proven instruction or completed checkpoint, never as the instruction. */
function canonicalMetadataEnvironmentBefore(
  input: unknown[],
  anchorIndex: number,
  metadata: Record<string, unknown>,
  requireMetadataBoundRoots = false,
): string | undefined {
  const metadataTurnId = metadata.turn_id;
  if (typeof metadataTurnId !== "string" || !metadataTurnId.trim()) return undefined;

  let candidateIndex = anchorIndex - 1;
  let candidate = record(input[candidateIndex]);
  while (candidate?.type === "message" && (candidate.role === "developer" || compactionSummaryMessage(candidate))) {
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
    if (item.type === "compaction" || item.type === "compaction_summary" || item.type === "context_compaction") return true;
    if (item.type === "message" && item.role === "user"
      && isReadableCompactionSummaryText(rawMessageText(item))) return true;
  }
  return false;
}

function rawEnvironmentText(parsed: CodexParsedRequest): string | undefined {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const metadata = clientTurnMetadata(parsed);
  let activeUserIndex = -1;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = record(input[index]);
    if (isNativeInstruction(item, metadata)) {
      activeUserIndex = index;
      break;
    }
  }
  const checkpoint = activeUserIndex < 0 ? recoverCompactionInstruction(parsed, extractChatGptTurnIdentity(parsed)) : undefined;
  const anchorIndex = checkpoint?.summaryIndex ?? activeUserIndex;
  const turnId = metadata?.turn_id;
  // A mid-turn update supersedes the start envelope too. Do not return that earlier authority
  // before the store can authenticate the delta against the current native turn context.
  if (input.slice(anchorIndex + 1).some(value => {
    const item = record(value);
    return hasEnvironmentContextFragment(item)
      && (itemTurnId(item) === undefined || itemTurnId(item) === turnId);
  })) return undefined;
  const currentByTurn = environmentBeforeUser(
    input,
    activeUserIndex,
    typeof turnId === "string" ? turnId : undefined,
    metadata,
  );
  if (currentByTurn) return currentByTurn;

  const current = checkpoint && metadata
    ? canonicalMetadataEnvironmentBefore(input, checkpoint.summaryIndex, metadata)
    : canonicalMetadataEnvironmentBeforeUser(input, activeUserIndex, metadata);
  if (current) return current;

  // Native steering appends same-turn user items without repeating the trusted envelope. Reuse
  // only an explicitly turn-owned pair, and never skip a newer environment attempt or provenance gap.
  if (typeof turnId === "string") {
    for (let index = activeUserIndex - 1; index > 0; index -= 1) {
      const following = record(input[index + 1]);
      if (following?.type !== "message" || following.role !== "user" || itemTurnId(following) !== turnId
        || hasEnvironmentContextAttempt(following.content)) break;
      const earlier = environmentBeforeUser(input, index, turnId, metadata);
      if (earlier && (metadata?.workspaces === undefined || environmentMatchesCanonicalMetadata(earlier, metadata, true))) return earlier;
    }
  }

  // A skill invocation appends another server-owned user item after the real instruction. Recover
  // the earlier current-turn environment/prompt pair only through canonical metadata, and bind all
  // declared roots to metadata workspaces so user-authored XML cannot widen filesystem authority.
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
    const replayed = environmentBeforeUser(input, index, undefined, metadata);
    if (replayed) return replayed;
  }

  // Native transcript replay needs a matching historical pair and assistant boundary, or
  // server-owned provenance whose authority still matches current workspace/sandbox metadata.
  const currentTurnId = typeof turnId === "string" ? turnId : undefined;
  const currentThreadId = typeof metadata?.thread_id === "string" && metadata.thread_id.trim()
    ? metadata.thread_id
    : undefined;
  const activeUser = record(input[activeUserIndex]);
  const activeUserOwned = isNativeInstruction(activeUser, metadata)
    && typeof activeUser.id === "string"
    && activeUser.id.length > 0
    && itemTurnId(activeUser) === currentTurnId;
  if (currentTurnId && itemTurnId(activeUser) === currentTurnId) {
    for (let index = activeUserIndex - 1; index > 0; index -= 1) {
      const historicalUser = record(input[index]);
      const historicalTurnId = itemTurnId(historicalUser);
      if (!historicalTurnId || historicalTurnId === currentTurnId) continue;
      const historical = environmentBeforeUser(input, index, undefined, metadata);
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
