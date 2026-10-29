import { Database } from "bun:sqlite";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { matchesPath as contains, pathIdentity } from "./environment-paths";
import { environmentFromTurnContext, absolutePaths } from "./codex-rollout-permissions";
import { expandUserPath } from "../../config";
import { findTopLevelAssignment } from "../../codex-integration-document";
import type { CodexTool } from "../../types";
import type {
  ChatGptRootThreadMetadata,
  ChatGptThreadSpawnLineage,
  ChatGptTurnEnvironment,
} from "./environment";
import type { ChatGptUnattributedEnvironmentMessage } from "./environment-history";

type RolloutIdentity = ChatGptRootThreadMetadata | ChatGptThreadSpawnLineage;
type CurrentTurnAnchor = {
  id: string;
  type: string;
  role: unknown;
  content: unknown;
  author: unknown;
  recipient: unknown;
  name?: unknown;
  namespace?: unknown;
  output?: unknown;
  call_id?: unknown;
};

export interface CodexRolloutEnvironment {
  environment: ChatGptTurnEnvironment;
  workspaceRootsDeclared: boolean;
  codexHome: string;
  /** Native model-visible projection; never used to grant execution permissions. */
  filesystemProfileXml?: string;
}

const CODEX_ID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const CODEX_ID = new RegExp(`^${CODEX_ID_SOURCE}$`, "i");
const ROLLOUT_READ_CHUNK_BYTES = 64 * 1024;
const MAX_ROLLOUT_JSON_LINE_BYTES = 16 * 1024 * 1024;
const MAX_ROLLOUT_DIRECTORY_ENTRIES = 100_000;

type IndexedRollout =
  | { kind: "unavailable" }
  | { kind: "absent" }
  | { kind: "found"; path: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function matchesAgentPath(value: unknown, expected: string): boolean {
  return expected === "/root" ? value == null : value === expected;
}

function canonicalRolloutName(name: string, threadId: string): boolean {
  const escapedThreadId = threadId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-${escapedThreadId}(?:_${CODEX_ID_SOURCE})?\\.jsonl$`,
    "i",
  ).test(name);
}

function configuredSqliteHome(codexHome: string, explicit?: string, inheritEnvironment = true): string {
  if (explicit) return resolve(explicit);

  const configPath = join(codexHome, "config.toml");
  if (existsSync(configPath)) {
    const configured = findTopLevelAssignment(
      readFileSync(configPath, "utf8").split(/\r\n|\n|\r/),
      "sqlite_home",
    );
    if (configured.present) {
      const value = configured.value?.trim();
      if (!value) throw new Error("sqlite_home in Codex config must not be empty");
      return resolve(codexHome, expandUserPath(value));
    }
  }

  const environmentValue = inheritEnvironment ? process.env.CODEX_SQLITE_HOME?.trim() : undefined;
  return resolve(environmentValue ? expandUserPath(environmentValue) : codexHome);
}

function indexedRollout(
  sqliteHome: string,
  identity: RolloutIdentity,
): IndexedRollout {
  const databasePath = join(sqliteHome, "state_5.sqlite");
  if (!existsSync(databasePath)) return { kind: "unavailable" };
  let database: Database | undefined;
  try {
    database = new Database(databasePath, { readonly: true, strict: true });
    const row = database.query(`
      SELECT t.rollout_path, t.agent_path, e.parent_thread_id, e.status
      FROM threads AS t
      LEFT JOIN thread_spawn_edges AS e ON e.child_thread_id = t.id
      WHERE t.id = ?
      LIMIT 1
    `).get(identity.threadId) as {
      rollout_path?: unknown;
      agent_path?: unknown;
      parent_thread_id?: unknown;
      status?: unknown;
    } | null;
    if (!row) return { kind: "absent" };
    const child = "parentThreadId" in identity;
    const matchesOwner = child
      ? matchesAgentPath(row.agent_path, identity.agentName)
        && row.parent_thread_id === identity.parentThreadId && row.status === "open"
      : row.parent_thread_id == null && (row.agent_path == null || row.agent_path === "/root");
    if (typeof row.rollout_path !== "string" || !matchesOwner) {
      throw new Error(`Codex state does not authenticate the requested ${child ? "subagent" : "root thread"} rollout`);
    }
    return { kind: "found", path: row.rollout_path };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Codex state does not authenticate the requested ")) {
      throw error;
    }
    // State storage is optional in Codex. A missing/older schema does not create authority; the
    // canonical rollout itself can still prove the exact thread, its lineage, and current turn.
    return { kind: "unavailable" };
  } finally {
    database?.close();
  }
}

function validateRolloutPath(codexHome: string, candidate: string, threadId: string): string {
  if (!isAbsolute(candidate)) throw new Error("Codex state returned a non-absolute rollout path");
  const sessionsRoot = realpathSync(join(codexHome, "sessions"));
  if (lstatSync(candidate).isSymbolicLink()) throw new Error("Codex rollout path is a symbolic link");
  const rolloutPath = realpathSync(candidate);
  if (!lstatSync(rolloutPath).isFile()) throw new Error("Codex rollout path is not a regular file");
  if (!contains(sessionsRoot, rolloutPath)) throw new Error("Codex rollout path escapes the sessions directory");
  if (!canonicalRolloutName(basename(rolloutPath), threadId)) {
    throw new Error("Codex rollout filename does not belong to the requested thread");
  }
  return rolloutPath;
}

function scanCanonicalRollouts(codexHome: string, threadId: string): string[] {
  const sessionsRoot = join(codexHome, "sessions");
  if (!existsSync(sessionsRoot)) return [];
  const matches: string[] = [];
  let visited = 0;
  const visitLevel = (path: string, depth: number): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      visited += 1;
      if (visited > MAX_ROLLOUT_DIRECTORY_ENTRIES) {
        throw new Error("Codex sessions directory is too large for an unindexed rollout lookup");
      }
      if (entry.isSymbolicLink()) continue;
      const child = join(path, entry.name);
      if (depth < 3) {
        if (entry.isDirectory() && /^\d+$/.test(entry.name)) visitLevel(child, depth + 1);
        continue;
      }
      if (entry.isFile() && canonicalRolloutName(entry.name, threadId)) matches.push(child);
    }
  };
  visitLevel(sessionsRoot, 0);
  return matches;
}

function parseJsonLine(line: Buffer): Record<string, unknown> {
  try {
    const parsed = JSON.parse(line.toString("utf8").replace(/^\uFEFF/, ""));
    const item = record(parsed);
    if (!item) throw new Error("not an object");
    return item;
  } catch (error) {
    throw new Error("Codex rollout contains an invalid complete JSONL record", { cause: error });
  }
}

function firstRolloutRecord(fd: number, size: number): Record<string, unknown> {
  let position = 0;
  let buffered = Buffer.alloc(0);
  while (position < size) {
    const length = Math.min(ROLLOUT_READ_CHUNK_BYTES, size - position);
    const chunk = Buffer.alloc(length);
    const count = readSync(fd, chunk, 0, length, position);
    if (count <= 0) break;
    position += count;
    buffered = Buffer.concat([buffered, chunk.subarray(0, count)]);
    const newline = buffered.indexOf(0x0a);
    if (newline >= 0) return parseJsonLine(buffered.subarray(0, newline));
    if (buffered.length > MAX_ROLLOUT_JSON_LINE_BYTES) {
      throw new Error("Codex rollout session metadata exceeds the bounded JSONL record size");
    }
  }
  throw new Error("Codex rollout has no complete session metadata record");
}

function latestRolloutPayload(fd: number, size: number, type: "turn_context" | "compacted"): Record<string, unknown> | undefined {
  let position = size;
  let carry = Buffer.alloc(0);
  let firstSegmentAtEof = true;
  const fileEndsWithNewline = (() => {
    if (size === 0) return false;
    const byte = Buffer.alloc(1);
    return readSync(fd, byte, 0, 1, size - 1) === 1 && byte[0] === 0x0a;
  })();

  while (position > 0) {
    const length = Math.min(ROLLOUT_READ_CHUNK_BYTES, position);
    position -= length;
    const chunk = Buffer.alloc(length);
    const count = readSync(fd, chunk, 0, length, position);
    if (count !== length) throw new Error("Codex rollout changed during authority lookup");
    const data = Buffer.concat([chunk, carry]);
    let lineEnd = data.length;
    for (let index = data.length - 1; index >= 0; index -= 1) {
      if (data[index] !== 0x0a) continue;
      const line = data.subarray(index + 1, lineEnd);
      const trailingPartial = firstSegmentAtEof && !fileEndsWithNewline;
      firstSegmentAtEof = false;
      lineEnd = index;
      if (trailingPartial || line.length === 0) continue;
      if (line.length > MAX_ROLLOUT_JSON_LINE_BYTES) {
        throw new Error("Codex rollout JSONL record exceeds the bounded record size");
      }
      const item = parseJsonLine(line);
      if (item.type === type) return record(item.payload);
    }
    carry = Buffer.from(data.subarray(0, lineEnd));
    if (carry.length > MAX_ROLLOUT_JSON_LINE_BYTES) {
      throw new Error("Codex rollout JSONL record exceeds the bounded record size");
    }
  }
  if (carry.length === 0) return undefined;
  const item = parseJsonLine(carry);
  return item.type === type ? record(item.payload) : undefined;
}

function verifyCompactedEnvironmentItems(fd: number, size: number, items: Record<string, unknown>[]): void {
  const compacted = latestRolloutPayload(fd, size, "compacted");
  const history = Array.isArray(compacted?.replacement_history) ? compacted.replacement_history : [];
  let previousIndex = -1;
  for (const item of items) {
    const matches = history.flatMap((value, index) => record(value)?.id === item.id ? [{ value, index }] : []);
    if (matches.length !== 1 || matches[0]!.index <= previousIndex || !isDeepStrictEqual(matches[0]!.value, item)) {
      throw new Error("Environment message or checkpoint differs from the latest native compaction");
    }
    previousIndex = matches[0]!.index;
  }
}

function validateSessionMeta(
  item: Record<string, unknown>,
  identity: RolloutIdentity,
): void {
  const payload = record(item.payload);
  if (!("parentThreadId" in identity)) {
    if (item.type !== "session_meta" || payload?.id !== identity.threadId
      || typeof payload.source !== "string" || payload.source === "subagent"
      || payload.parent_thread_id != null || payload.thread_source === "subagent"
      || (payload.agent_path != null && payload.agent_path !== "/root")) {
      throw new Error("Codex rollout session metadata does not authenticate the requested root thread");
    }
    return;
  }
  const lineage = identity;
  const source = record(payload?.source);
  const subagent = record(source?.subagent);
  const spawn = record(subagent?.thread_spawn);
  if (item.type !== "session_meta"
    || payload?.id !== lineage.threadId
    || payload.parent_thread_id !== lineage.parentThreadId
    || !matchesAgentPath(payload.agent_path, lineage.agentName)
    || payload.thread_source !== "subagent"
    || spawn?.parent_thread_id !== lineage.parentThreadId
    || !matchesAgentPath(spawn.agent_path, lineage.agentName)) {
    throw new Error("Codex rollout session metadata does not authenticate the requested subagent");
  }
}

function verifyHistoricalEnvironmentMessages(
  fd: number,
  size: number,
  turnId: string,
  messages: ChatGptUnattributedEnvironmentMessage[],
): void {
  const pending = new Map(messages.map(message => [message.id, message.content]));
  if (pending.size !== messages.length) throw new Error("Codex environment history repeats a message id");
  let position = 0;
  let carry = Buffer.alloc(0);
  while (position < size) {
    const length = Math.min(ROLLOUT_READ_CHUNK_BYTES, size - position);
    const chunk = Buffer.alloc(length);
    if (readSync(fd, chunk, 0, length, position) !== length) {
      throw new Error("Codex rollout changed during environment history lookup");
    }
    position += length;
    const data = Buffer.concat([carry, chunk]);
    let start = 0;
    for (let end = data.indexOf(0x0a); end >= 0; end = data.indexOf(0x0a, start)) {
      const line = data.subarray(start, end);
      start = end + 1;
      if (!line.length) continue;
      if (line.length > MAX_ROLLOUT_JSON_LINE_BYTES) throw new Error("Codex rollout JSONL record exceeds the bounded record size");
      const item = parseJsonLine(line);
      const payload = record(item.payload);
      if (item.type === "event_msg" && payload?.type === "task_started" && payload.turn_id === turnId) {
        if (pending.size === 0) return;
        throw new Error("Codex rollout does not authenticate the historical environment messages");
      }
      if (item.type !== "response_item" || payload?.type !== "message" || payload.role !== "user"
        || typeof payload.id !== "string" || !pending.has(payload.id)) continue;
      if (!isDeepStrictEqual(payload.content, pending.get(payload.id))) {
        throw new Error("Historical environment message differs from its native Codex record");
      }
      pending.delete(payload.id);
    }
    carry = Buffer.from(data.subarray(start));
    if (carry.length > MAX_ROLLOUT_JSON_LINE_BYTES) throw new Error("Codex rollout JSONL record exceeds the bounded record size");
  }
  throw new Error("Codex rollout has no current task boundary for environment history");
}

function verifyCurrentTurnAnchor(
  fd: number,
  size: number,
  turnId: string,
  anchor: CurrentTurnAnchor,
): void {
  let position = 0;
  let carry = Buffer.alloc(0);
  let inCurrentTurn = false;
  let matched = false;
  let mismatched = false;
  let currentContext = false;
  while (position < size) {
    const length = Math.min(ROLLOUT_READ_CHUNK_BYTES, size - position);
    const chunk = Buffer.alloc(length);
    if (readSync(fd, chunk, 0, length, position) !== length) {
      throw new Error("Codex rollout changed during current-turn anchor lookup");
    }
    position += length;
    const data = Buffer.concat([carry, chunk]);
    let start = 0;
    for (let end = data.indexOf(0x0a); end >= 0; end = data.indexOf(0x0a, start)) {
      const line = data.subarray(start, end);
      start = end + 1;
      if (!line.length) continue;
      if (line.length > MAX_ROLLOUT_JSON_LINE_BYTES) throw new Error("Codex rollout JSONL record exceeds the bounded record size");
      const item = parseJsonLine(line);
      const payload = record(item.payload);
      if (item.type === "event_msg" && payload?.type === "task_started") {
        inCurrentTurn = payload.turn_id === turnId;
        matched = false;
        mismatched = false;
        currentContext = false;
        continue;
      }
      if (!inCurrentTurn) continue;
      if (item.type === "response_item" && payload?.id === anchor.id) {
        const candidate: CurrentTurnAnchor = {
          id: payload.id as string,
          type: payload.type as string,
          role: payload.role,
          content: payload.content,
          author: payload.author,
          recipient: payload.recipient,
          ...(payload.type === "function_call_output" ? {
            name: payload.name, namespace: payload.namespace, output: payload.output, call_id: payload.call_id,
          } : {}),
        };
        if (!isDeepStrictEqual(candidate, anchor)) {
          mismatched = true;
          continue;
        }
        matched = true;
        continue;
      }
      if (item.type === "turn_context" && payload?.turn_id === turnId) {
        currentContext = true;
        continue;
      }
    }
    carry = Buffer.from(data.subarray(start));
    if (carry.length > MAX_ROLLOUT_JSON_LINE_BYTES) throw new Error("Codex rollout JSONL record exceeds the bounded record size");
  }
  if (inCurrentTurn && mismatched) {
    throw new Error("Current-turn anchor differs from its native Codex record");
  }
  if (inCurrentTurn && matched && currentContext) return;
  throw new Error("Codex rollout has no authenticated current-turn anchor boundary");
}

/**
 * Codex's model-visible projection, after environmentFromTurnContext validates execution policy.
 * See codex-rs/core/src/context/environment_context.rs (rust-v0.154.0): expand project roots,
 * deduplicate full entries, omit missing_path_behavior, and mark deny entries non-escalatable.
 * Comparing the whole projection keeps calendar updates from introducing different permissions.
 */
function renderFilesystemProfile(value: unknown, roots: string[]): string | undefined {
  const profile = record(value);
  if (profile?.type === "disabled") {
    return '<permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile>';
  }
  const fs = record(profile?.file_system);
  if (profile?.type !== "managed" || fs?.type !== "restricted" || !Array.isArray(fs.entries)) return undefined;
  const entries: Record<string, unknown>[] = [];
  for (const raw of fs.entries) {
    const entry = record(raw);
    const path = record(entry?.path);
    if (!entry || !path) return undefined;
    const special = path.type === "special" ? record(path.value) : undefined;
    const expanded = special?.kind === "project_roots"
      ? roots.map(root => ({ ...entry, path: { type: "path", path: typeof special.subpath === "string" ? join(root, special.subpath) : root } }))
      : [entry];
    for (const candidate of expanded) {
      if (!entries.some(prior => isDeepStrictEqual(prior, candidate))) entries.push(candidate);
    }
  }
  const xml = (text: string): string => text.replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[char]!);
  const rendered: string[] = [];
  for (const entry of entries) {
    const path = record(entry.path)!;
    let tag: string;
    let text: unknown;
    if (path.type === "path") { tag = "path"; text = path.path; }
    else if (path.type === "glob_pattern") { tag = "glob"; text = path.pattern; }
    else if (path.type === "special") {
      tag = "special";
      const special = record(path.value);
      if (!special || !["root", "minimal", "tmpdir", "slash_tmp"].includes(String(special.kind))) return undefined;
      text = `:${special.kind}`;
    } else return undefined;
    if (typeof text !== "string") return undefined;
    rendered.push(`<entry access="${entry.access}"${entry.access === "deny" ? ' escalatable="false"' : ""}><${tag}>${xml(text)}</${tag}></entry>`);
  }
  const depth = fs.glob_scan_max_depth === undefined ? "" : ` glob_scan_max_depth="${fs.glob_scan_max_depth}"`;
  return `<permission_profile type="managed"><file_system type="restricted"${depth}>${rendered.join("")}</file_system></permission_profile>`;
}

function validateMetadataConsistency(
  lineage: RolloutIdentity,
  environment: ChatGptTurnEnvironment,
  workspaceRootsDeclared: boolean,
): void {
  // Request sandbox/workspace fields are diagnostic only. They narrow a rollout-derived authority
  // here and never create or expand it.
  const owner = "parentThreadId" in lineage ? "subagent" : "thread";
  if (lineage.sandboxType === "platform"
    ? environment.sandboxPolicy.type === "dangerFullAccess"
    : environment.sandboxPolicy.type !== lineage.sandboxType) {
    throw new Error(`ChatGPT Web ${owner} sandbox metadata conflicts with its Codex rollout`);
  }
  if (lineage.workspaceRoots.length > 0
    && !lineage.workspaceRoots.some(root => contains(root, environment.cwd))) {
    throw new Error(`ChatGPT Web ${owner} workspace metadata does not contain its Codex rollout cwd`);
  }
  if ((workspaceRootsDeclared || environment.sandboxPolicy.type !== "dangerFullAccess")
    && lineage.workspaceRoots.some(root => (
      !environment.roots.some(rolloutRoot => contains(rolloutRoot, root) || contains(root, rolloutRoot))
      && !(environment.sandboxPolicy.type === "dangerFullAccess"
        && pathIdentity(root) === pathIdentity(environment.cwd))
    ))) {
    throw new Error(`ChatGPT Web ${owner} workspace metadata conflicts with its Codex rollout roots`);
  }
}

export function resolveCurrentCodexRolloutEnvironment(options: {
  codexHome: string;
  additionalCodexHomes?: readonly string[];
  sqliteHome?: string;
  lineage: RolloutIdentity;
  turnId: string;
  compactionSourceTurnId?: string;
  tools?: readonly CodexTool[];
  historicalEnvironmentMessages?: ChatGptUnattributedEnvironmentMessage[];
  currentTurnAnchor?: CurrentTurnAnchor;
  compactedEnvironmentItems?: Record<string, unknown>[];
}): CodexRolloutEnvironment | undefined {
  const { codexHome, lineage, turnId, tools, compactionSourceTurnId } = options;
  const nativeThreadId = CODEX_ID.test(lineage.threadId);
  const nativeTurnId = CODEX_ID.test(turnId);
  if (!nativeThreadId && !nativeTurnId) return undefined;
  if (!nativeThreadId || !nativeTurnId || (compactionSourceTurnId !== undefined && !CODEX_ID.test(compactionSourceTurnId))
    || ("parentThreadId" in lineage && !CODEX_ID.test(lineage.parentThreadId))) {
    throw new Error("Codex thread metadata contains an invalid native identifier");
  }

  // Establish one home before interpreting its permissions. Even a stale copy of
  // the same thread in another registered home makes ownership ambiguous.
  const owners = [codexHome, ...(options.additionalCodexHomes ?? [])].map((home, index) => {
    const indexed = indexedRollout(configuredSqliteHome(
      home, index === 0 ? options.sqliteHome : undefined, index === 0,
    ), lineage);
    const candidates = indexed.kind === "found" ? [indexed.path] : scanCanonicalRollouts(home, lineage.threadId);
    return { home, indexed, candidates };
  }).filter(owner => owner.candidates.length > 0);
  if (owners.length > 1) throw new Error("Codex thread exists in multiple trusted homes");
  const owner = owners[0];
  if (!owner) {
    throw new Error(`Codex has no canonical rollout for the requested ${"parentThreadId" in lineage ? "subagent" : "root"} thread`);
  }

  const matching: CodexRolloutEnvironment[] = [];
  for (const candidate of owner.candidates) {
    const rolloutPath = validateRolloutPath(owner.home, candidate, lineage.threadId);
    const fd = openSync(rolloutPath, "r");
    try {
      const size = fstatSync(fd).size;
      if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Codex rollout is empty");
      const session = firstRolloutRecord(fd, size);
      validateSessionMeta(session, lineage);
      const sessionPayload = record(session.payload)!;
      const runtimeWorkspaceRoots = sessionPayload.runtime_workspace_roots === undefined
        ? undefined : absolutePaths(sessionPayload.runtime_workspace_roots, "runtime_workspace_roots");
      const latest = latestRolloutPayload(fd, size, "turn_context");
      if (!latest) throw new Error("Codex rollout has no complete turn context");
      if (latest.turn_id !== turnId && (compactionSourceTurnId === undefined || latest.turn_id !== compactionSourceTurnId)) {
        if (owner.indexed.kind === "found") {
          throw new Error("Latest Codex rollout turn context does not belong to the requested turn");
        }
        continue;
      }
      const environment = environmentFromTurnContext(latest, latest.turn_id as string, tools, runtimeWorkspaceRoots);
      const workspaceRootsDeclared = latest.workspace_roots !== undefined || runtimeWorkspaceRoots !== undefined;
      validateMetadataConsistency(lineage, environment, workspaceRootsDeclared);
      if (options.historicalEnvironmentMessages) {
        verifyHistoricalEnvironmentMessages(fd, size, turnId, options.historicalEnvironmentMessages);
      }
      if (options.currentTurnAnchor) {
        verifyCurrentTurnAnchor(fd, size, turnId, options.currentTurnAnchor);
      }
      if (options.compactedEnvironmentItems) {
        verifyCompactedEnvironmentItems(fd, size, options.compactedEnvironmentItems);
      }
      const filesystemProfileXml = renderFilesystemProfile(latest.permission_profile, environment.roots);
      matching.push({ environment, workspaceRootsDeclared, filesystemProfileXml, codexHome: owner.home });
    } finally {
      closeSync(fd);
    }
  }
  if (matching.length === 0) {
    throw new Error("Codex has no canonical rollout for the requested current turn");
  }
  if (matching.length > 1) {
    throw new Error("Codex has multiple canonical rollouts for the requested current turn");
  }
  return matching[0]!;
}
