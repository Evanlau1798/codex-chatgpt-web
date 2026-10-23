import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getTrustedCodexHomes } from "../src/codex-integration-shared";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { parseRequest } from "../src/responses/parser";

const threadId = "01a06c66-4232-7ae1-9108-69b5f70e0671";
const turnId = "01a06c66-4380-75c6-a0df-318f890ef6de";
const otherId = "01a06c66-18ad-73e1-a641-9b114f2ed10c";
type Mode = "read-only" | "workspace-write" | "danger-full-access";
let root: string;
let primary: string;
let secondary: string;
let cwd: string;
let originalHomes: string | undefined;
let originalSqlite: string | undefined;

beforeEach(() => {
  originalHomes = process.env.CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES;
  originalSqlite = process.env.CODEX_SQLITE_HOME;
  delete process.env.CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES;
  delete process.env.CODEX_SQLITE_HOME;
  root = realpathSync(mkdtempSync(join(tmpdir(), "codex-trusted-homes-")));
  primary = join(root, "primary");
  secondary = join(root, "secondary");
  cwd = join(root, "project");
  for (const path of [primary, secondary, cwd]) mkdirSync(path);
});

afterEach(() => {
  if (originalHomes === undefined) delete process.env.CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES;
  else process.env.CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES = originalHomes;
  if (originalSqlite === undefined) delete process.env.CODEX_SQLITE_HOME;
  else process.env.CODEX_SQLITE_HOME = originalSqlite;
  rmSync(root, { recursive: true, force: true });
});

function request(options: {
  mode?: Mode; network?: boolean; envelope?: boolean; workspace?: string;
  child?: boolean; currentTurn?: string;
} = {}) {
  const mode = options.mode ?? "read-only";
  const workspace = options.workspace ?? cwd;
  const currentTurn = options.currentTurn ?? turnId;
  const profile = mode === "danger-full-access"
    ? '<permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile>'
    : '<permission_profile type="managed"><file_system type="restricted">'
      + '<entry access="read"><special>:root</special></entry>'
      + (mode === "workspace-write" ? `<entry access="write"><path>${workspace}</path></entry>`
        + '<entry access="write"><special>:slash_tmp</special></entry>'
        + '<entry access="write"><special>:tmpdir</special></entry>' : "")
      + '</file_system></permission_profile>';
  // Enhanced accepts native-environment claims from identified messages only.
  const message = (text: string, id: string) => ({
    id, type: "message", role: "user", content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: currentTurn },
  });
  const parsed = parseRequest({
    model: "chatgpt-web/high",
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({
      request_kind: "turn", thread_id: threadId, turn_id: currentTurn,
      sandbox_mode: mode, workspaces: { [workspace]: {} },
      ...(options.child ? {
        parent_thread_id: otherId, agent_name: "/root/worker", subagent_kind: "thread_spawn",
      } : { agent_name: "/root" }),
    }) },
    input: [
      ...(options.envelope === false ? [] : [message(`<environment_context><cwd>${workspace}</cwd>`
        + (options.network === undefined ? "" : `<network_access>${options.network ? "enabled" : "restricted"}</network_access>`)
        + `<filesystem><workspace_roots><root>${workspace}</root></workspace_roots>${profile}</filesystem></environment_context>`, "msg_current_env")]),
      message("Inspect the workspace", "msg_current_request"),
    ],
  });
  parsed.context.tools = [{ name: "current_tool", description: "Current tool", parameters: { type: "object" } }];
  return parsed;
}

function rollout(home: string, options: {
  mode?: Mode; network?: boolean; child?: boolean; overrides?: Record<string, unknown>;
} = {}) {
  const mode = options.mode ?? "read-only";
  const network = options.network ?? false;
  const entries = [
    { path: { type: "special", value: { kind: "root" } }, access: "read" },
    ...(mode === "workspace-write" ? [
      { path: { type: "path", path: cwd }, access: "write" },
      ...["slash_tmp", "tmpdir"].map(kind => ({ path: { type: "special", value: { kind } }, access: "write" })),
    ] : []),
  ];
  const path = join(home, "sessions", "2026", "10", "18", `rollout-2026-10-18T10-00-00-${threadId}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [
    { type: "session_meta", payload: {
      id: threadId,
      ...(options.child ? {
        parent_thread_id: otherId, agent_path: "/root/worker", thread_source: "subagent",
        source: { subagent: { thread_spawn: { parent_thread_id: otherId, agent_path: "/root/worker", depth: 1 } } },
      } : { source: "cli" }),
    } },
    { type: "turn_context", payload: {
      turn_id: turnId, cwd,
      // Stock Codex 0.162 omits workspace_roots here and network access in the XML.
      sandbox_policy: { type: mode, ...(mode === "danger-full-access" ? {} : { network_access: network }),
        ...(mode === "workspace-write" ? { writable_roots: [] } : {}) },
      permission_profile: mode === "danger-full-access" ? { type: "disabled" } : {
        type: "managed", file_system: { type: "restricted", entries }, network: network ? "enabled" : "restricted",
      },
      ...options.overrides,
    } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  return path;
}

function index(home: string, path: string, agent: string | null = null) {
  mkdirSync(home, { recursive: true });
  const db = new Database(join(home, "state_5.sqlite"), { create: true });
  try {
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, agent_path TEXT)");
    db.exec("CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY, status TEXT)");
    db.query("INSERT INTO threads VALUES (?, ?, ?)").run(threadId, path, agent);
  } finally { db.close(); }
}

function sharedStore(cache?: string) {
  return new ChatGptThreadEnvironmentStore(cache, Date.now, primary, undefined, [secondary]);
}

describe("explicit trusted Codex homes (#851)", () => {
  test("a native root cannot authorize itself with a complete envelope when its rollout is absent", () => {
    expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, primary)
      .resolve(request({ mode: "danger-full-access" }))).toThrow("no canonical rollout");
  });
  test("a second native home is inaccessible until the operator registers it", () => {
    rollout(secondary);
    const parsed = request();
    // Request-side directory hints must never register a home.
    Object.assign(parsed._rawBody!, { codex_home: secondary, trusted_codex_homes: [secondary] });
    expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, primary).resolve(parsed))
      .toThrow("no canonical rollout");
    process.env.CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES = JSON.stringify([secondary]);
    expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, primary).resolve(parsed).sandboxPolicy)
      .toEqual({ type: "readOnly", networkAccess: false });
  });

  for (const mode of ["read-only", "workspace-write"] as const) {
    for (const network of [false, true]) {
      test(`${mode} resolves both homes with native network=${network}`, () => {
        const parsed = request({ mode });
        const store = sharedStore();
        for (const home of [primary, secondary]) {
          const path = rollout(home, { mode, network });
          const result = store.resolve(parsed);
          expect(result.sandboxPolicy).toMatchObject({ networkAccess: network });
          expect(result.writableRoots).toEqual(mode === "workspace-write" ? [cwd] : []);
          expect(result.tools).toEqual(parsed.context.tools!);
          rmSync(path);
        }
      });
    }
  }

  test("complete envelopes still require current native ownership", () => {
    const parsed = request({ mode: "danger-full-access" });
    expect(() => sharedStore().resolve(parsed)).toThrow("no canonical rollout");
    rollout(secondary, { mode: "danger-full-access" });
    expect(sharedStore().resolve(parsed).sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    expect(() => sharedStore().resolve(request({ mode: "danger-full-access", currentTurn: otherId })))
      .toThrow("current turn");
  });

  test.each([false, true])("duplicate thread ownership is rejected even when one copy is stale (indexed=%s)", indexed => {
    rollout(secondary);
    const old = rollout(primary, { overrides: { turn_id: otherId } });
    if (indexed) index(primary, old);
    expect(() => sharedStore().resolve(request())).toThrow("multiple trusted homes");
  });

  test("no cache is read or written in shared-home mode", () => {
    const cache = join(root, "environments.json");
    const primaryRollout = rollout(primary, { mode: "danger-full-access" });
    new ChatGptThreadEnvironmentStore(cache, Date.now, primary).resolve(request({ mode: "danger-full-access" }));
    rmSync(primaryRollout);
    const original = readFileSync(cache, "utf8");
    const path = rollout(secondary);
    const store = sharedStore(cache);
    expect(store.resolve(request()).sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
    expect(readFileSync(cache, "utf8")).toBe(original);
    rmSync(path);
    expect(() => store.resolve(request({ envelope: false }))).toThrow("no canonical rollout");
    expect(() => sharedStore(cache).resolve(request({ envelope: false }))).toThrow("no canonical rollout");
    expect(readFileSync(cache, "utf8")).toBe(original);
    rollout(secondary);
    const freshCache = join(root, "new-cache.json");
    sharedStore(freshCache).resolve(request());
    expect(existsSync(freshCache)).toBe(false);
  });

  test("request and native permission, cwd and root conflicts remain errors", () => {
    rollout(secondary);
    expect(() => sharedStore().resolve(request({ network: true }))).toThrow("environment conflicts with its current Codex rollout");
    expect(() => sharedStore().resolve(request({ mode: "danger-full-access" }))).toThrow("sandbox metadata conflicts");
    expect(() => sharedStore().resolve(request({ workspace: secondary }))).toThrow("does not contain");
    rollout(secondary, { overrides: { workspace_roots: [root] } });
    expect(() => sharedStore().resolve(request())).toThrow("environment conflicts with its current Codex rollout");
    rollout(secondary, { overrides: { workspace_roots: null } });
    expect(() => sharedStore().resolve(request())).toThrow("workspace_roots");
  });

  test("secondary state location is per-home and does not inherit the primary process override", () => {
    const path = rollout(secondary);
    const state = join(secondary, "native-state");
    index(state, path, "/wrong-owner");
    writeFileSync(join(secondary, "config.toml"), 'sqlite_home = "native-state"\n');
    expect(() => sharedStore().resolve(request())).toThrow("does not authenticate");
    rmSync(join(secondary, "config.toml"));
    index(secondary, path);
    process.env.CODEX_SQLITE_HOME = state;
    const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, primary, primary, [secondary]);
    expect(store.resolve(request()).sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
  });

  test("secondary subagents retain native lineage checks", () => {
    rollout(secondary, { child: true });
    expect(sharedStore().resolve(request({ child: true })).sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
    expect(() => sharedStore().resolve(request())).toThrow();
    rollout(secondary);
    expect(() => sharedStore().resolve(request({ child: true }))).toThrow();
  });

  test("an indexed path cannot escape its registered home", () => {
    const unregistered = join(root, "unregistered");
    const path = rollout(unregistered);
    mkdirSync(join(secondary, "sessions"));
    index(secondary, path);
    expect(() => sharedStore().resolve(request())).toThrow("escapes the sessions directory");
  });
});

describe("trusted home registration", () => {
  test.each(['{}', '"/home"', '["relative"]', '["//host/share"]', '[null]', '[', JSON.stringify(Array(8).fill("/home")), JSON.stringify(["/" + "a".repeat(4096)])])("invalid configuration is rejected: %j", raw => {
    process.env.CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES = raw;
    expect(() => getTrustedCodexHomes(primary)).toThrow();
  });

  test("registration requires existing directories", () => {
    expect(() => getTrustedCodexHomes(primary, [join(root, "absent")])).toThrow("existing directory");
    const file = join(root, "file");
    writeFileSync(file, "not a directory");
    expect(() => getTrustedCodexHomes(primary, [file])).toThrow("existing directory");
  });

  test("canonical directory aliases are deduplicated, while symlink roots are rejected", () => {
    const alias = join(root, "alias");
    symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
    expect(getTrustedCodexHomes(primary, [secondary, join(alias, "secondary"), primary]))
      .toEqual([primary, secondary]);
    expect(() => getTrustedCodexHomes(primary, [alias])).toThrow("existing directory");
  });
});
