import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import type { CodexParsedRequest, CodexTool } from "../src/types";
import { root, currentWire, environmentXml, dangerFullAccessProfileXml } from "./environment-fixture";
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

import { extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { rememberCompactionContinuation } from "../src/adapters/chatgpt-web/compaction-continuation";
import { encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
function resumedRootFixture(): { codexHome: string; request: CodexParsedRequest; rolloutPath: string } {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-chatgpt-root-resume-"));
  temporaryRoots.push(codexHome);
  const rolloutPath = join(codexHome, "sessions", "2026", "09", "04",
    `rollout-2026-09-04T15-30-36-${rolloutThreadId}.jsonl`);
  mkdirSync(dirname(rolloutPath), { recursive: true });
  writeFileSync(rolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: rolloutThreadId, source: "vscode" } }),
    JSON.stringify(childTurnContext()),
  ].join("\n") + "\n");
  const request = environmentlessChild();
  const body = request._rawBody as { client_metadata: Record<string, string> };
  body.client_metadata["x-codex-turn-metadata"] = JSON.stringify({
    request_kind: "turn", thread_id: rolloutThreadId, turn_id: rolloutTurnId,
    agent_name: "/root", sandbox_mode: "danger-full-access", workspaces: { [root]: {} },
  });
  return { codexHome, request, rolloutPath };
}

test("recovers an ordinary resumed task from its exact current rollout with an empty bridge cache", () => {
  const { codexHome, request } = resumedRootFixture();
  request.context.tools = [{ name: "current_tool", description: "current", parameters: { type: "object" } }];
  expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request)).toEqual({
    cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" },
    tools: request.context.tools,
  });
});

for (const format of ["v1", "v2"]) test(`${format} context-only continuation requires a matching current rollout, not just a checkpoint`, () => {
  const { codexHome, request, rolloutPath } = resumedRootFixture();
  const body = request._rawBody as { input: Array<Record<string, unknown>> };
  const oldTurnId = "01a06c66-0000-75c6-a0df-318f890ef6de";
  body.input[0]!.internal_chat_message_metadata_passthrough = { turn_id: oldTurnId };
  const summary = `Confirmed ${format} checkpoint`;
  rememberCompactionContinuation({ ...request, _compactionRequest: true }, extractChatGptTurnIdentity(request), [
    { turnId: oldTurnId, content: body.input[0]!.content },
  ], summary);
  const current = {
    type: "message", role: "user", id: "msg_current_environment",
    content: [{ type: "input_text", text: environmentXml }],
    internal_chat_message_metadata_passthrough: { turn_id: rolloutTurnId },
  };
  const checkpoint = format === "v2"
    ? { type: "compaction", encrypted_content: encodeCompactionSummary(summary) }
    : { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${summary}` }] };
  body.input.push(current, checkpoint);
  const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
  expect(store.resolve(request).cwd).toBe(root);
  for (const text of [
    environmentXml.replaceAll(root, resolve(root, "another-workspace")),
    environmentXml.replace('<permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile>',
      '<sandbox_mode>read-only</sandbox_mode>'),
    "<environment_context><cwd/></environment_context>",
  ]) {
    current.content[0]!.text = text;
    expect(() => store.resolve(request)).toThrow();
  }
  current.content[0]!.text = environmentXml;
  body.input.pop();
  expect(() => store.resolve(request)).toThrow("missing cwd");
  body.input.push(checkpoint);
  writeFileSync(rolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: rolloutThreadId, source: "vscode" } }),
    JSON.stringify(childTurnContext(oldTurnId)),
  ].join("\n") + "\n");
  // A valid cached environment and matching wire claim cannot overrule a different native turn.
  expect(() => store.resolve(request)).toThrow("current turn");
});

test("old untagged transcript context cannot block or replace current rollout authority after restart", () => {
  const { codexHome, request } = resumedRootFixture();
  const oldRoot = resolve(root, "previous-workspace");
  const body = request._rawBody as { input: Array<Record<string, unknown>> };
  body.input.unshift(
    { type: "message", role: "user", id: "old_environment", content: [{ type: "input_text", text:
      `<environment_context><cwd>${oldRoot}</cwd><sandbox_mode>danger-full-access</sandbox_mode></environment_context>` }] },
    { type: "message", role: "user", id: "old_user", content: [{ type: "input_text", text: "Previous request" }] },
    { type: "message", role: "assistant", id: "old_reply", content: [{ type: "output_text", text: "Completed" }] },
  );
  expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request).cwd).toBe(root);
});

test("a resumed root cannot borrow a child rollout or an earlier turn's authority", () => {
  const { codexHome, request, rolloutPath } = resumedRootFixture();
  writeFileSync(rolloutPath, [JSON.stringify(childSessionMeta()), JSON.stringify(childTurnContext())].join("\n") + "\n");
  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request))
    .toThrow("session metadata");
  writeFileSync(rolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: rolloutThreadId, source: "vscode" } }),
    JSON.stringify(childTurnContext("01a06c66-ffff-75c6-a0df-318f890ef6de")),
  ].join("\n") + "\n");
  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request))
    .toThrow("current turn");
});

test("a malformed current update is not replaced by a valid older transcript envelope", () => {
  const { codexHome, request } = resumedRootFixture();
  const body = request._rawBody as { input: Array<Record<string, unknown>> };
  const oldTurnId = "01a06c66-0000-75c6-a0df-318f890ef6de";
  body.input.unshift(
    { type: "message", role: "user", id: "old_context", content: [{ type: "input_text", text: environmentXml }],
      internal_chat_message_metadata_passthrough: { turn_id: oldTurnId } },
    { type: "message", role: "user", id: "old_user", content: [{ type: "input_text", text: "Previous task" }],
      internal_chat_message_metadata_passthrough: { turn_id: oldTurnId } },
    { type: "message", role: "assistant", id: "old_answer", content: [{ type: "output_text", text: "Done" }] },
    { type: "message", role: "user", id: "invalid_current_context",
      content: [{ type: "input_text", text: "<environment_context><cwd/></environment_context>" }] },
  );
  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request)).toThrow("missing cwd");
});

test("root rollout lookup authenticates the indexed owner and current sandbox", () => {
  const { codexHome, request, rolloutPath } = resumedRootFixture();
  const databasePath = join(codexHome, "state_5.sqlite");
  createRolloutState(databasePath, rolloutPath);
  const database = new Database(databasePath);
  database.exec("DELETE FROM thread_spawn_edges");
  database.query("UPDATE threads SET agent_path = NULL WHERE id = ?").run(rolloutThreadId);
  expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request).cwd).toBe(root);
  const body = request._rawBody as { client_metadata: Record<string, string> };
  const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]!);
  metadata.sandbox_mode = "read-only";
  body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request))
    .toThrow("sandbox metadata conflicts");
  metadata.sandbox_mode = "danger-full-access";
  body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
  database.query("INSERT INTO thread_spawn_edges VALUES (?, ?, ?)").run(rolloutParentId, rolloutThreadId, "open");
  database.close();
  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request))
    .toThrow("does not authenticate");
});

test("compaction authenticates the latest native turn as current or source, never an arbitrary ancestor", () => {
  const { codexHome, request, rolloutPath } = resumedRootFixture();
  request._compactionRequest = true;
  const body = request._rawBody as { client_metadata: Record<string, string>; input: Array<Record<string, unknown>> };
  const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]!);
  metadata.request_kind = "compaction";
  metadata.turn_id = "01a06c66-ffff-75c6-a0df-318f890ef6de";
  body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
  body.input.push({ type: "compaction_trigger" });
  expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request).cwd).toBe(root);
  body.input[0]!.internal_chat_message_metadata_passthrough = { turn_id: "01a06c66-0000-75c6-a0df-318f890ef6de" };
  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request))
    .toThrow("current turn");
  writeFileSync(rolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: rolloutThreadId, source: "vscode" } }),
    JSON.stringify(childTurnContext(metadata.turn_id)),
  ].join("\n") + "\n");
  expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request).cwd).toBe(root);
  writeFileSync(rolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: rolloutThreadId, source: "vscode" } }),
    JSON.stringify(childTurnContext(metadata.turn_id, { turn_id: undefined })),
  ].join("\n") + "\n");
  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request))
    .toThrow("current turn");
});
