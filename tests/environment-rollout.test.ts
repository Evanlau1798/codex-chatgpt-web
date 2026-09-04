import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import type { CodexParsedRequest, CodexTool } from "../src/types";
import { root, currentWire, dangerFullAccessProfileXml } from "./environment-fixture";
const temporaryRoots: string[] = [];
afterEach(() => { for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true }); });

const rolloutThreadId = "01a06c66-4232-7ae1-9108-69b5f70e0671";
const rolloutTurnId = "01a06c66-4380-75c6-a0df-318f890ef6de";
const rolloutParentId = "01a06c66-18ad-73e1-a641-9b114f2ed10c";
const rolloutAgent = "/root/rollout_child";

function childSessionMeta(threadId = rolloutThreadId): Record<string, unknown> {
  return {
    type: "session_meta",
    payload: {
      id: threadId,
      parent_thread_id: rolloutParentId,
      cwd: root,
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: rolloutParentId,
            depth: 1,
            agent_path: rolloutAgent,
          },
        },
      },
      thread_source: "subagent",
      agent_path: rolloutAgent,
    },
  };
}

function childTurnContext(
  turnId = rolloutTurnId,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "turn_context",
    payload: {
      turn_id: turnId,
      cwd: root,
      workspace_roots: [root],
      approval_policy: "never",
      sandbox_policy: { type: "danger-full-access" },
      permission_profile: { type: "disabled" },
      model: "chatgpt-web/pro",
      summary: "auto",
      ...overrides,
    },
  };
}

function environmentlessChild(
  turnId = rolloutTurnId,
  sandboxMode = "danger-full-access",
  workspaceRoots: string[] = [root],
): CodexParsedRequest {
  const child = currentWire();
  child._rawBody = {
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        request_kind: "turn",
        thread_id: rolloutThreadId,
        turn_id: turnId,
        parent_thread_id: rolloutParentId,
        agent_name: rolloutAgent,
        subagent_kind: "thread_spawn",
        sandbox_mode: sandboxMode,
        workspaces: Object.fromEntries(workspaceRoots.map(path => [path, { has_changes: true }])),
      }),
    },
    input: [{
      type: "message",
      id: "msg_child_prompt",
      role: "user",
      content: [{ type: "input_text", text: "Inspect the inherited repository" }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    }],
  };
  return child;
}

function createRolloutState(databasePath: string, rolloutPath: string): void {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath, { create: true });
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, agent_path TEXT)");
  database.exec("CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL)");
  database.query("INSERT INTO threads (id, rollout_path, agent_path) VALUES (?, ?, ?)")
    .run(rolloutThreadId, rolloutPath, rolloutAgent);
  database.query("INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES (?, ?, ?)")
    .run(rolloutParentId, rolloutThreadId, "open");
  database.close();
}

test("recovers the exact current child rollout before stale cache using custom state storage", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-chatgpt-rollout-environment-"));
  const sqliteHome = mkdtempSync(join(tmpdir(), "codex-chatgpt-rollout-state-"));
  temporaryRoots.push(codexHome, sqliteHome);
  const sessionsRoot = join(codexHome, "sessions");
  const revertedRolloutId = "01a06c66-a0af-7769-b04e-976542277181";
  const rolloutPath = join(
    sessionsRoot,
    "2026",
    "09",
    "04",
    `rollout-2026-09-04T15-30-36-${rolloutThreadId}_${revertedRolloutId}.jsonl`,
  );
  mkdirSync(dirname(rolloutPath), { recursive: true });
  writeFileSync(rolloutPath, [
    JSON.stringify(childSessionMeta()),
    JSON.stringify(childTurnContext()),
  ].join("\n") + "\n");
  createRolloutState(join(sqliteHome, "state_5.sqlite"), rolloutPath);

  const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome, sqliteHome);
  const staleRoot = resolve(root, "stale-cached-root");
  const staleRequest = currentWire({
    workspace: staleRoot,
    environmentXml: `<environment_context><cwd>${staleRoot}</cwd><filesystem><workspace_roots><root>${staleRoot}</root></workspace_roots>${dangerFullAccessProfileXml}</filesystem></environment_context>`,
  });
  (staleRequest._rawBody as { client_metadata: Record<string, string> })
    .client_metadata["x-codex-turn-metadata"] = JSON.stringify({
      thread_id: rolloutThreadId,
      turn_id: "01a06c66-37dc-7c86-85f9-a92e0bb6b638",
      sandbox: "none",
      workspaces: { [staleRoot]: {} },
    });
  store.resolve(staleRequest);

  const child = environmentlessChild();
  const childTools: CodexTool[] = [{ name: "child_tool", description: "child", parameters: { type: "object" } }];
  child.context.tools = childTools;
  expect(store.resolve(child)).toEqual({
    cwd: root,
    roots: [root],
    writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" },
    tools: childTools,
  });

  const wrongTurn = environmentlessChild("01a06c66-ffff-75c6-a0df-318f890ef6de");
  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome, sqliteHome).resolve(wrongTurn))
    .toThrow("Latest Codex rollout turn context does not belong to the requested turn");

  const changedDatabase = new Database(join(sqliteHome, "state_5.sqlite"));
  changedDatabase.query("UPDATE threads SET agent_path = ? WHERE id = ?")
    .run("/root/another_child", rolloutThreadId);
  changedDatabase.close();
  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome, sqliteHome).resolve(child))
    .toThrow("Codex state does not authenticate the requested subagent rollout");
});

test("uses Codex's configured sqlite_home before environment/default state storage", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-chatgpt-rollout-config-home-"));
  const sqliteHome = mkdtempSync(join(tmpdir(), "codex-chatgpt-rollout-config-state-"));
  temporaryRoots.push(codexHome, sqliteHome);
  const rolloutPath = join(
    codexHome,
    "sessions",
    "2026",
    "09",
    "04",
    `rollout-2026-09-04T15-30-36-${rolloutThreadId}.jsonl`,
  );
  mkdirSync(dirname(rolloutPath), { recursive: true });
  writeFileSync(rolloutPath, [
    JSON.stringify(childSessionMeta()),
    JSON.stringify(childTurnContext()),
  ].join("\n") + "\n");
  writeFileSync(join(codexHome, "config.toml"), `sqlite_home = ${JSON.stringify(sqliteHome)}\n`);
  createRolloutState(join(sqliteHome, "state_5.sqlite"), rolloutPath);

  const previous = process.env.CODEX_SQLITE_HOME;
  process.env.CODEX_SQLITE_HOME = join(codexHome, "wrong-environment-state");
  try {
    expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome)
      .resolve(environmentlessChild()).cwd).toBe(root);
  } finally {
    if (previous === undefined) delete process.env.CODEX_SQLITE_HOME;
    else process.env.CODEX_SQLITE_HOME = previous;
  }
});

test("unindexed recovery selects the one canonical rollout whose latest turn is current", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-chatgpt-rollout-scan-"));
  temporaryRoots.push(codexHome);
  const oldRolloutPath = join(
    codexHome,
    "sessions",
    "2026",
    "09",
    "04",
    `rollout-2026-09-04T15-30-36-${rolloutThreadId}.jsonl`,
  );
  const revertedRolloutPath = join(
    dirname(oldRolloutPath),
    `rollout-2026-09-04T15-31-36-${rolloutThreadId}_01a06c66-a0af-7769-b04e-976542277181.jsonl`,
  );
  mkdirSync(dirname(oldRolloutPath), { recursive: true });
  writeFileSync(oldRolloutPath, [
    JSON.stringify(childSessionMeta()),
    JSON.stringify(childTurnContext("01a06c66-2b34-71d9-8907-6104c1a25b35")),
  ].join("\n") + "\n");
  writeFileSync(revertedRolloutPath, [
    JSON.stringify(childSessionMeta()),
    JSON.stringify(childTurnContext()),
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", data: "x".repeat(70_000) } }),
  ].join("\n") + "\n");

  expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(environmentlessChild()).cwd)
    .toBe(root);

  writeFileSync(revertedRolloutPath, [
    JSON.stringify(childSessionMeta()),
    JSON.stringify(childTurnContext("01a06c66-2b34-71d9-8907-6104c1a25b35")),
  ].join("\n") + "\n");
  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(environmentlessChild()))
    .toThrow("no canonical rollout for the requested current turn");

  writeFileSync(oldRolloutPath, [
    JSON.stringify(childSessionMeta()),
    JSON.stringify(childTurnContext()),
  ].join("\n") + "\n");
  writeFileSync(revertedRolloutPath, [
    JSON.stringify(childSessionMeta()),
    JSON.stringify(childTurnContext()),
  ].join("\n") + "\n");
  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(environmentlessChild()))
    .toThrow("multiple canonical rollouts for the requested current turn");
});

test("recovers byte-realistic workspace-write and read-only-with-network profiles", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-chatgpt-rollout-profiles-"));
  temporaryRoots.push(codexHome);
  const rolloutPath = join(
    codexHome,
    "sessions",
    "2026",
    "09",
    "04",
    `rollout-2026-09-04T15-30-36-${rolloutThreadId}.jsonl`,
  );
  const auxiliaryRoot = resolve(root, "rollout-visualization-output");
  const workspaceEntries = [
    { path: { type: "special", value: { kind: "root" } }, access: "read" },
    { path: { type: "path", path: root }, access: "write" },
    { path: { type: "path", path: auxiliaryRoot }, access: "write" },
    { path: { type: "special", value: { kind: "slash_tmp" } }, access: "write" },
    { path: { type: "special", value: { kind: "tmpdir" } }, access: "write" },
    { path: { type: "path", path: join(root, ".git") }, access: "read", missing_path_behavior: "skip" },
    { path: { type: "path", path: join(auxiliaryRoot, ".agents") }, access: "read", missing_path_behavior: "skip" },
    { path: { type: "path", path: resolve(root, "..", "external-worktree-gitdir") }, access: "read" },
    { path: { type: "glob_pattern", pattern: `${root}/private/**` }, access: "deny" },
  ];
  mkdirSync(dirname(rolloutPath), { recursive: true });
  writeFileSync(rolloutPath, [
    JSON.stringify(childSessionMeta()),
    JSON.stringify(childTurnContext(rolloutTurnId, {
      workspace_roots: [root, auxiliaryRoot],
      sandbox_policy: {
        type: "workspace-write",
        writable_roots: [auxiliaryRoot],
        network_access: true,
        exclude_tmpdir_env_var: false,
        exclude_slash_tmp: false,
      },
      permission_profile: {
        type: "managed",
        file_system: { type: "restricted", entries: workspaceEntries },
        network: "enabled",
      },
      file_system_sandbox_policy: { kind: "restricted", entries: workspaceEntries },
    })),
  ].join("\n") + "\n");

  expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(
    environmentlessChild(rolloutTurnId, "workspace-write", [root, auxiliaryRoot]),
  )).toEqual({
    cwd: root,
    roots: [root, auxiliaryRoot],
    writableRoots: [root, auxiliaryRoot],
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [root, auxiliaryRoot],
      networkAccess: true,
    },
    tools: [],
  });

  writeFileSync(rolloutPath, [
    JSON.stringify(childSessionMeta()),
    JSON.stringify(childTurnContext(rolloutTurnId, {
      workspace_roots: [root, auxiliaryRoot],
      sandbox_policy: {
        type: "workspace-write",
        writable_roots: [auxiliaryRoot],
        network_access: true,
        exclude_tmpdir_env_var: true,
        exclude_slash_tmp: false,
      },
      permission_profile: {
        type: "managed",
        file_system: { type: "restricted", entries: workspaceEntries },
        network: "enabled",
      },
      file_system_sandbox_policy: { kind: "restricted", entries: workspaceEntries },
    })),
  ].join("\n") + "\n");
  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(
    environmentlessChild(rolloutTurnId, "workspace-write", [root, auxiliaryRoot]),
  )).toThrow("workspace-write permission profile is inconsistent");

  const readOnlyEntries = [
    { path: { type: "special", value: { kind: "root" } }, access: "read" },
    { path: { type: "path", path: root }, access: "read" },
    { path: { type: "special", value: { kind: "slash_tmp" } }, access: "read" },
    { path: { type: "path", path: resolve(root, "..", "external-worktree-gitdir") }, access: "read" },
    { path: { type: "glob_pattern", pattern: `${root}/private/**` }, access: "deny" },
  ];
  writeFileSync(rolloutPath, [
    JSON.stringify(childSessionMeta()),
    JSON.stringify(childTurnContext(rolloutTurnId, {
      sandbox_policy: { type: "read-only", network_access: true },
      permission_profile: {
        type: "managed",
        file_system: {
          type: "restricted",
          entries: readOnlyEntries,
        },
        network: "enabled",
      },
      file_system_sandbox_policy: { kind: "restricted", entries: readOnlyEntries },
    })),
  ].join("\n") + "\n");

  expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(
    environmentlessChild(rolloutTurnId, "read-only"),
  ).sandboxPolicy).toEqual({ type: "readOnly", networkAccess: true });
});

test("fails closed when canonical rollout proof is absent or permission fields diverge", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-chatgpt-rollout-fail-closed-"));
  temporaryRoots.push(codexHome);
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
  const stale = currentWire();
  (stale._rawBody as { client_metadata: Record<string, string> })
    .client_metadata["x-codex-turn-metadata"] = JSON.stringify({
      thread_id: rolloutThreadId,
      turn_id: "01a06c66-37dc-7c86-85f9-a92e0bb6b638",
      sandbox: "none",
      workspaces: { [root]: {} },
    });
  store.resolve(stale);
  expect(() => store.resolve(environmentlessChild()))
    .toThrow("no canonical rollout for the requested subagent thread");

  const rolloutPath = join(
    codexHome,
    "sessions",
    "2026",
    "09",
    "04",
    `rollout-2026-09-04T15-30-36-${rolloutThreadId}.jsonl`,
  );
  mkdirSync(dirname(rolloutPath), { recursive: true });
  writeFileSync(rolloutPath, [
    JSON.stringify(childSessionMeta()),
    JSON.stringify(childTurnContext(rolloutTurnId, {
      sandbox_policy: { type: "read-only", network_access: true },
      permission_profile: {
        type: "managed",
        file_system: {
          type: "restricted",
          entries: [{ path: { type: "special", value: { kind: "root" } }, access: "read" }],
        },
        network: "restricted",
      },
    })),
  ].join("\n") + "\n");
  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(
    environmentlessChild(rolloutTurnId, "read-only"),
  )).toThrow("read-only permission profile is inconsistent");

  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(
    environmentlessChild("turn-not-native"),
  )).toThrow("invalid native identifier");
});

test("rollout recovery rejects outside paths and never repairs malformed raw authority", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-chatgpt-rollout-rejection-"));
  temporaryRoots.push(codexHome);
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  const outsidePath = join(codexHome, `rollout-2026-09-04T15-30-36-${rolloutThreadId}.jsonl`);
  writeFileSync(outsidePath, [
    JSON.stringify(childSessionMeta()),
    JSON.stringify(childTurnContext()),
  ].join("\n") + "\n");
  createRolloutState(join(codexHome, "state_5.sqlite"), outsidePath);

  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(environmentlessChild()))
    .toThrow("Codex rollout path escapes the sessions directory");

  const validPath = join(
    codexHome,
    "sessions",
    "2026",
    "09",
    "04",
    `rollout-2026-09-04T15-30-36-${rolloutThreadId}.jsonl`,
  );
  mkdirSync(dirname(validPath), { recursive: true });
  writeFileSync(validPath, [
    JSON.stringify(childSessionMeta()),
    JSON.stringify(childTurnContext()),
  ].join("\n") + "\n");
  const database = new Database(join(codexHome, "state_5.sqlite"));
  database.query("UPDATE threads SET rollout_path = ? WHERE id = ?").run(validPath, rolloutThreadId);
  database.close();
  const malformed = environmentlessChild();
  const rawInput = (malformed._rawBody as { input: Array<Record<string, unknown>> }).input;
  rawInput.unshift({
    type: "message",
    id: "msg_malformed_environment",
    role: "user",
    content: [{ type: "input_text", text: "<environment_context><cwd/></environment_context>" }],
    internal_chat_message_metadata_passthrough: { turn_id: rolloutTurnId },
  });
  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(malformed))
    .toThrow("missing cwd");
});
