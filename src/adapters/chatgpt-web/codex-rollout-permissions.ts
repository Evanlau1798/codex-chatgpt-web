import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CodexTool } from "../../types";
import type { ChatGptTurnEnvironment } from "./environment";
import { pathIdentity, matchesPath as contains } from "./environment-paths";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function absolutePaths(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(path => typeof path !== "string" || !isAbsolute(path))) {
    throw new Error(`Codex rollout ${field} is invalid`);
  }
  const unique = new Map<string, string>();
  for (const path of value as string[]) {
    const normalized = resolve(path);
    if (!unique.has(pathIdentity(normalized))) unique.set(pathIdentity(normalized), normalized);
  }
  return [...unique.values()];
}

function validGlobScanMaxDepth(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) > 0);
}

function validRestrictiveEntry(entryValue: unknown): { rootRead: boolean } | undefined {
  const entry = record(entryValue);
  const path = record(entry?.path);
  if (!entry || !path
    || (entry.access !== "read" && entry.access !== "deny")
    || (entry.missing_path_behavior !== undefined && entry.missing_path_behavior !== "skip")) return undefined;
  if (path.type === "special") {
    const special = record(path.value)?.kind;
    if (typeof special !== "string" || !special) return undefined;
    return {
      rootRead: special === "root"
        && entry.access === "read"
        && entry.missing_path_behavior === undefined,
    };
  }
  if (path.type === "path") {
    return typeof path.path === "string" && isAbsolute(path.path) ? { rootRead: false } : undefined;
  }
  if (path.type === "glob_pattern") {
    return typeof path.pattern === "string" && path.pattern.length > 0 ? { rootRead: false } : undefined;
  }
  return undefined;
}

function exactManagedReadOnlyProfile(
  value: Record<string, unknown>,
  expectedNetwork: "enabled" | "restricted",
): boolean {
  const fileSystem = record(value.file_system);
  const entries = fileSystem?.entries;
  if (fileSystem?.type !== "restricted"
    || !validGlobScanMaxDepth(fileSystem.glob_scan_max_depth)
    || !Array.isArray(entries)
    || value.network !== expectedNetwork) return false;
  let rootReads = 0;
  for (const entry of entries) {
    const restrictive = validRestrictiveEntry(entry);
    if (!restrictive) return false;
    if (restrictive.rootRead) rootReads += 1;
  }
  return rootReads === 1;
}

function networkAccess(value: Record<string, unknown>, field: string): boolean {
  if (value.network_access !== undefined && typeof value.network_access !== "boolean") {
    throw new Error(`Codex rollout ${field} network_access is invalid`);
  }
  return value.network_access === true;
}

function splitPolicyMatchesProfile(
  splitValue: unknown,
  profileFileSystem: Record<string, unknown>,
): boolean {
  if (splitValue === undefined || splitValue === null) return true;
  const split = record(splitValue);
  if (!split) return false;
  const profileType = profileFileSystem.type;
  if (profileType !== "restricted" && profileType !== "unrestricted") return false;
  if (split.kind !== profileType) return false;
  if (profileType === "unrestricted") {
    return split.entries === undefined && split.glob_scan_max_depth === undefined;
  }
  return isDeepStrictEqual(split.entries, profileFileSystem.entries)
    && split.glob_scan_max_depth === profileFileSystem.glob_scan_max_depth;
}

function exactManagedWorkspaceWriteProfile(
  profile: Record<string, unknown>,
  roots: string[],
  cwd: string,
  sandbox: Record<string, unknown>,
): { networkAccess: boolean; writableRoots: string[] } | undefined {
  const fileSystem = record(profile.file_system);
  if (fileSystem?.type !== "restricted"
    || !validGlobScanMaxDepth(fileSystem.glob_scan_max_depth)
    || !Array.isArray(fileSystem.entries)
    || (profile.network !== "restricted" && profile.network !== "enabled")) return undefined;

  const rawWritableRoots = sandbox.writable_roots ?? [];
  if (!Array.isArray(rawWritableRoots)
    || rawWritableRoots.some(path => typeof path !== "string" || !isAbsolute(path))
    || (sandbox.exclude_tmpdir_env_var !== undefined && typeof sandbox.exclude_tmpdir_env_var !== "boolean")
    || (sandbox.exclude_slash_tmp !== undefined && typeof sandbox.exclude_slash_tmp !== "boolean")) return undefined;
  const expectedWritableRoots = [cwd, ...rawWritableRoots.map(path => resolve(path as string))];
  const uniqueExpectedWritableRoots = [...new Map(expectedWritableRoots.map(path => (
    [pathIdentity(path), path] as const
  ))).values()];
  if (uniqueExpectedWritableRoots.length !== expectedWritableRoots.length
    || uniqueExpectedWritableRoots.some(path => !roots.some(root => contains(root, path)))) return undefined;

  let rootRead = 0;
  let projectRootsWrite = 0;
  const directWrites: string[] = [];
  const specialWrites = new Set<string>();
  for (const value of fileSystem.entries) {
    const entry = record(value);
    const path = record(entry?.path);
    if (!entry || !path
      || (entry.access !== "read" && entry.access !== "write" && entry.access !== "deny")
      || (entry.missing_path_behavior !== undefined && entry.missing_path_behavior !== "skip")) return undefined;

    if (path.type === "special") {
      const special = record(path.value)?.kind;
      if (special === "root" && entry.access === "read" && entry.missing_path_behavior === undefined) {
        rootRead += 1;
        continue;
      }
      if (entry.access !== "write") {
        if (typeof special !== "string" || !special) return undefined;
        continue;
      }
      if (special === "project_roots" && entry.access === "write" && entry.missing_path_behavior === undefined) {
        projectRootsWrite += 1;
        continue;
      }
      if ((special === "slash_tmp" || special === "tmpdir")
        && entry.access === "write"
        && entry.missing_path_behavior === undefined
        && !specialWrites.has(special)) {
        specialWrites.add(special);
        continue;
      }
      return undefined;
    }

    // Read/deny entries only narrow the profile. Codex legitimately adds external worktree gitdirs
    // and protected metadata paths here, so they do not affect the writable authority recovered
    // by this bridge. Every write entry, in contrast, must be one of the exact legacy roots below.
    if (entry.access !== "write") {
      if (path.type === "path") {
        if (typeof path.path !== "string" || !isAbsolute(path.path)) return undefined;
      } else if (path.type === "glob_pattern") {
        if (typeof path.pattern !== "string" || !path.pattern) return undefined;
      } else {
        return undefined;
      }
      continue;
    }
    if (path.type !== "path"
      || typeof path.path !== "string"
      || !isAbsolute(path.path)
      || entry.missing_path_behavior !== undefined) return undefined;
    directWrites.push(resolve(path.path));
  }

  if (rootRead !== 1 || projectRootsWrite > 1) return undefined;
  const uniqueDirectWrites = [...new Map(directWrites.map(path => (
    [pathIdentity(path), path] as const
  ))).values()];
  if (uniqueDirectWrites.length !== directWrites.length) return undefined;
  const expectedIdentities = new Set(uniqueExpectedWritableRoots.map(pathIdentity));
  if (uniqueDirectWrites.some(path => !expectedIdentities.has(pathIdentity(path)))) return undefined;
  if (projectRootsWrite === 0 && uniqueDirectWrites.length !== uniqueExpectedWritableRoots.length) return undefined;
  if (projectRootsWrite === 1) {
    const rootIdentities = new Set(roots.map(pathIdentity));
    if (rootIdentities.size !== expectedIdentities.size
      || [...rootIdentities].some(path => !expectedIdentities.has(path))) return undefined;
  }

  const expectsSlashTmp = sandbox.exclude_slash_tmp !== true;
  const expectsTmpdir = sandbox.exclude_tmpdir_env_var !== true;
  if (specialWrites.has("slash_tmp") !== expectsSlashTmp
    || specialWrites.has("tmpdir") !== expectsTmpdir) return undefined;

  return {
    networkAccess: profile.network === "enabled",
    writableRoots: uniqueExpectedWritableRoots,
  };
}

export function environmentFromTurnContext(
  payload: Record<string, unknown>,
  expectedTurnId: string,
  tools: readonly CodexTool[] | undefined,
): ChatGptTurnEnvironment {
  if (payload.turn_id !== expectedTurnId) {
    throw new Error("Latest Codex rollout turn context does not belong to the requested turn");
  }
  if (typeof payload.cwd !== "string" || !isAbsolute(payload.cwd)) {
    throw new Error("Codex rollout cwd is invalid");
  }
  const cwd = resolve(payload.cwd);
  const declaredRoots = payload.workspace_roots === undefined
    ? []
    : absolutePaths(payload.workspace_roots, "workspace_roots");
  const roots = declaredRoots.length > 0 ? declaredRoots : [cwd];
  if (!roots.some(root => contains(root, cwd))) {
    throw new Error("Codex rollout cwd is outside its workspace roots");
  }

  const permissionProfile = record(payload.permission_profile);
  const sandbox = record(payload.sandbox_policy);
  if (!permissionProfile || !sandbox) {
    throw new Error("Codex rollout is missing its authoritative permission profile");
  }
  if (permissionProfile.type === "disabled" && sandbox.type === "danger-full-access") {
    const split = payload.file_system_sandbox_policy;
    if (split !== undefined && split !== null) {
      const unrestricted = record(split);
      if (unrestricted?.kind !== "unrestricted"
        || unrestricted.entries !== undefined
        || unrestricted.glob_scan_max_depth !== undefined) {
        throw new Error("Codex rollout split filesystem policy conflicts with full access");
      }
    }
    return {
      cwd,
      roots,
      writableRoots: roots,
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [...(tools ?? [])],
    };
  }
  if (permissionProfile.type === "managed" && sandbox.type === "read-only") {
    const enabled = networkAccess(sandbox, "read-only");
    const expectedNetwork = enabled ? "enabled" : "restricted";
    const fileSystem = record(permissionProfile.file_system);
    if (!fileSystem
      || !exactManagedReadOnlyProfile(permissionProfile, expectedNetwork)
      || !splitPolicyMatchesProfile(payload.file_system_sandbox_policy, fileSystem)) {
      throw new Error("Codex rollout read-only permission profile is inconsistent");
    }
    return {
      cwd,
      roots,
      writableRoots: [],
      sandboxPolicy: { type: "readOnly", networkAccess: enabled },
      tools: [...(tools ?? [])],
    };
  }
  if (permissionProfile.type === "managed" && sandbox.type === "workspace-write") {
    const fileSystem = record(permissionProfile.file_system);
    const workspace = exactManagedWorkspaceWriteProfile(permissionProfile, roots, cwd, sandbox);
    if (!fileSystem
      || !workspace
      || networkAccess(sandbox, "workspace-write") !== workspace.networkAccess
      || !splitPolicyMatchesProfile(payload.file_system_sandbox_policy, fileSystem)) {
      throw new Error("Codex rollout workspace-write permission profile is inconsistent");
    }
    return {
      cwd,
      roots,
      writableRoots: workspace.writableRoots,
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: workspace.writableRoots,
        networkAccess: workspace.networkAccess,
      },
      tools: [...(tools ?? [])],
    };
  }
  throw new Error("Codex rollout permission profile cannot be represented safely by the Web bridge");
}
