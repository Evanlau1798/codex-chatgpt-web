import { extractChatGptTurnEnvironment, extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import type { CodexParsedRequest, CodexTool } from "../src/types";
import { parseRequest } from "../src/responses/parser";
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

function updateRolloutState(databasePath: string, update: (database: Database) => void): void {
  const database = new Database(databasePath);
  try { update(database); } finally { database.close(); }
}

import { extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { rememberCompactionContinuation } from "../src/adapters/chatgpt-web/compaction-continuation";
import { COMPACT_PROMPT, encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
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

test("a current environment claim cannot replace exact rollout authority", () => {
  const { codexHome, request } = resumedRootFixture();
  const body = request._rawBody as { input: Array<Record<string, unknown>> };
  const claimedRoot = join(root, "not-the-rollout-cwd");
  body.input.unshift({
    type: "message", role: "user", id: "msg_conflicting_current_environment",
    content: [{ type: "input_text", text: `<environment_context><cwd>${claimedRoot}</cwd><workspace_roots><root>${root}</root></workspace_roots>${dangerFullAccessProfileXml}</environment_context>` }],
    internal_chat_message_metadata_passthrough: { turn_id: rolloutTurnId },
  });

  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request))
    .toThrow("current Codex rollout");
});

test.each(["function", "custom_tool", "tool_search"])("a running resumed root validates refreshes after %s activity", kind => {
  const { codexHome, request, rolloutPath } = resumedRootFixture();
  const body = request._rawBody as { input: Array<Record<string, unknown>> };
  const owned = { turn_id: rolloutTurnId };
  body.input.push({ type: `${kind}_call`, id: "fc_wait", call_id: "wait", name: "wait_agent", arguments: "{}",
    internal_chat_message_metadata_passthrough: owned },
  { type: kind === "tool_search" ? "tool_search_output" : `${kind}_call_output`, id: "fco_wait", call_id: "wait", output: '{"timed_out":true}',
    internal_chat_message_metadata_passthrough: owned });
  const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
  expect(store.resolve(request).cwd).toBe(root);
  const update = { type: "message", role: "user", id: "midnight_environment",
    content: [{ type: "input_text", text: `<environment_context><current_date>2026-09-13</current_date><filesystem><workspace_roots><root>${root}</root></workspace_roots>${dangerFullAccessProfileXml}</filesystem><subagents>Fermat</subagents></environment_context>` }],
    internal_chat_message_metadata_passthrough: owned };
  body.input.push(update);
  expect(store.resolve(request).cwd).toBe(root);
  expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request).cwd).toBe(root);
  for (const index of [1, 2]) {
    const original = body.input[index]!;
    for (const patch of [{ id: undefined }, { type: "unknown_native_item" },
      { internal_chat_message_metadata_passthrough: { turn_id: rolloutParentId } }]) {
      body.input[index] = { ...original, ...patch };
      expect(store.resolve(request).cwd).toBe(root);
    }
    body.input[index] = original;
  }
  for (const patch of [
    { id: undefined }, { internal_chat_message_metadata_passthrough: {} },
    { role: "developer" },
    { content: [{ type: "input_text", text: "<environment_context><cwd/></environment_context>" }] },
    { content: [{ type: "input_text", text: environmentXml.replaceAll(root, join(root, "other")) }] },
    { content: [{ type: "input_text", text: update.content[0]!.text }, { type: "input_text", text: "New instruction" }] },
  ]) {
    body.input[body.input.length - 1] = { ...update, ...patch };
    expect(() => store.resolve(request), JSON.stringify(patch)).toThrow();
  }
  // A different turn cannot append a new environment claim to the active turn.
  body.input[body.input.length - 1] = { ...update,
    internal_chat_message_metadata_passthrough: { turn_id: rolloutParentId },
    content: [{ type: "input_text", text: environmentXml.replaceAll(root, join(root, "other")) }] };
  expect(() => store.resolve(request)).toThrow();
  body.input[body.input.length - 1] = update;
  writeFileSync(rolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: rolloutThreadId, source: "vscode" } }),
    JSON.stringify(childTurnContext(rolloutParentId)),
  ].join("\n") + "\n");
  expect(() => store.resolve(request)).toThrow("current turn");
});

test.each(["ordinary", "v1 compact", "v2 compact"].flatMap(history => ["root", "child"].map(actor => [history, actor] as const)))("%s %s keeps verified refresh authority across later steering and agent results", (history, actor) => {
  const fixture = resumedRootFixture();
  const { codexHome, rolloutPath } = fixture;
  const request = actor === "child" ? environmentlessChild() : fixture.request;
  if (actor === "child") writeFileSync(rolloutPath, [JSON.stringify(childSessionMeta()), JSON.stringify(childTurnContext())].join("\n") + "\n");
  const body = request._rawBody as { input: Array<Record<string, unknown>> };
  const owned = { turn_id: rolloutTurnId };
  const item = (value: Record<string, unknown>) => ({ ...value, internal_chat_message_metadata_passthrough: owned });
  const user = (id: string, text: string) => item({ type: "message", role: "user", id,
    content: [{ type: "input_text", text }] });
  const instruction = (id: string, text: string): Record<string, unknown> => actor === "root" ? user(id, text)
    : { type: "agent_message", id, author: "/root", recipient: rolloutAgent, content: [{ type: "input_text", text }] };
  body.input[0] = instruction("initial_instruction", "Inspect the repository.");
  if (history !== "ordinary") {
    const summary = "Earlier work is complete.";
    const earlier = instruction("earlier_revision", "Earlier work in the same native turn.");
    body.input.unshift(earlier,
      history === "v2 compact" ? { type: "compaction", encrypted_content: encodeCompactionSummary(summary) }
        : { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${summary}` }] });
    rememberCompactionContinuation(
      { ...request, _compactionRequest: true },
      extractChatGptTurnIdentity(request),
      [{ ...(actor === "root" ? { turnId: rolloutTurnId } : {}), itemId: earlier.id as string, content: earlier.content }],
      summary,
    );
  }
  body.input.push(
    item({ type: "function_call", id: "fc_work", call_id: "work", name: "exec_command", arguments: "{}" }),
    item({ type: "function_call_output", id: "fco_work", call_id: "work", output: "done" }),
  );
  const refresh = user("environment_refresh", `<environment_context><filesystem><workspace_roots><root>${root}</root></workspace_roots>${dangerFullAccessProfileXml}</filesystem></environment_context>`);
  body.input.push(refresh);
  const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
  expect(store.resolve(request).cwd).toBe(root);
  const beforeFollowup = structuredClone(body.input);

  for (const action of ["close_agent", "exec_command", "none"]) {
    body.input = structuredClone(beforeFollowup);
    body.input.push(user("completed_notification", '<subagent_notification>{"status":{"completed":"Review complete."}}</subagent_notification>'));
    if (action !== "none") body.input.push(
      item({ type: "function_call", id: "fc_followup", call_id: "followup", name: action, arguments: "{}" }),
      item({ type: "function_call_output", id: "fco_followup", call_id: "followup", output: "done" }),
    );
    body.input.push(instruction("steering", "Stop after reporting the current result."));
    expect(store.resolve(request).cwd).toBe(root);
    expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request).cwd).toBe(root);
  }
  // A second revision and environment update must not invalidate the first verified update.
  body.input.push({ ...refresh, id: "second_environment_refresh" },
    item({ type: "tool_search_call", id: "tsc_next", call_id: "next", arguments: {} }),
    item({ type: "tool_search_output", id: "tso_next", call_id: "next", tools: [] }),
    instruction("second_steering", "Keep the result concise."));
  expect(store.resolve(request).cwd).toBe(root);
  expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request).cwd).toBe(root);

  const valid = structuredClone(body.input);
  for (const index of [valid.findIndex(value => value.id === "fc_work"), valid.findIndex(value => value.id === "steering"), valid.length - 1]) {
    const patches: Array<Record<string, unknown>> = [{ id: undefined }, { internal_chat_message_metadata_passthrough: { turn_id: rolloutParentId } }];
    if (valid[index]?.type === "agent_message") patches.push({ author: "/root/sibling" }, { recipient: "/root/another_child" });
    else patches.push({ internal_chat_message_metadata_passthrough: {} });
    for (const patch of patches) {
      body.input = structuredClone(valid);
      body.input[index] = { ...body.input[index], ...patch };
      expect(store.resolve(request).cwd, `${index}: ${JSON.stringify(patch)}`).toBe(root);
    }
  }
  for (const patch of [
    { id: undefined },
    { internal_chat_message_metadata_passthrough: {} },
    { internal_chat_message_metadata_passthrough: { turn_id: rolloutParentId } },
    { role: "developer" },
  ]) {
    body.input = structuredClone(valid);
    const index = body.input.findIndex(value => value.id === "environment_refresh");
    body.input[index] = { ...body.input[index], ...patch };
    expect(() => store.resolve(request), `environment refresh: ${JSON.stringify(patch)}`).toThrow();
  }
  for (const text of ["<environment_context><cwd/></environment_context>", environmentXml.replaceAll(root, join(root, "other")),
    `<environment_context><cwd>${root}</cwd><sandbox_mode>read-only</sandbox_mode></environment_context>`,
    `${environmentXml}\nDo something else.`]) {
    body.input = structuredClone(valid);
    body.input[body.input.findIndex(value => value.id === "environment_refresh")] = user("environment_refresh", text);
    expect(() => store.resolve(request)).toThrow();
  }
  body.input = valid;
  writeFileSync(rolloutPath, [JSON.stringify(actor === "child" ? childSessionMeta() : { type: "session_meta", payload: { id: rolloutThreadId, source: "vscode" } }),
    JSON.stringify(childTurnContext(rolloutParentId))].join("\n") + "\n");
  expect(() => store.resolve(request)).toThrow("current turn");
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
  const { codexHome, request, rolloutPath } = resumedRootFixture();
  const oldRoot = resolve(root, "previous-workspace");
  const body = request._rawBody as { input: Array<Record<string, unknown>> };
  body.input.unshift(
    { type: "message", role: "user", id: "old_environment", content: [{ type: "input_text", text:
      `<environment_context><cwd>${oldRoot}</cwd><sandbox_mode>danger-full-access</sandbox_mode></environment_context>` }] },
    { type: "message", role: "user", id: "old_user", content: [{ type: "input_text", text: "Previous request" }] },
    { type: "message", role: "assistant", id: "old_reply", content: [{ type: "output_text", text: "Completed" }] },
  );
  const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
  expect(() => store.resolve(request)).toThrow("no current task boundary");
  writeFileSync(rolloutPath, [
    { type: "session_meta", payload: { id: rolloutThreadId, source: "vscode" } },
    { type: "response_item", payload: body.input[0] },
    { type: "event_msg", payload: { type: "task_started", turn_id: rolloutTurnId } },
    childTurnContext(),
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  expect(store.resolve(request).cwd).toBe(root);
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
  const { codexHome, request, rolloutPath } = resumedRootFixture();
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
  const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
  expect(() => store.resolve(request)).toThrow();
  // A recorded malformed current envelope is still not historical authority.
  writeFileSync(rolloutPath, [
    { type: "session_meta", payload: { id: rolloutThreadId, source: "vscode" } },
    { type: "response_item", payload: body.input[0] },
    { type: "event_msg", payload: { type: "task_started", turn_id: rolloutTurnId } },
    { type: "response_item", payload: body.input[3] },
    childTurnContext(),
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  expect(() => store.resolve(request)).toThrow("missing cwd");
});

test("root rollout lookup authenticates the indexed owner and current sandbox", () => {
  const { codexHome, request, rolloutPath } = resumedRootFixture();
  const databasePath = join(codexHome, "state_5.sqlite");
  createRolloutState(databasePath, rolloutPath);
  // Finish fixture writes before the independent authority reader opens it.
  // A failed assertion must never strand a writer across Windows teardown.
  updateRolloutState(databasePath, database => {
    database.exec("DELETE FROM thread_spawn_edges");
    database.query("UPDATE threads SET agent_path = NULL WHERE id = ?").run(rolloutThreadId);
  });
  expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request).cwd).toBe(root);
  const body = request._rawBody as { client_metadata: Record<string, string> };
  const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]!);
  metadata.sandbox_mode = "read-only";
  body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request))
    .toThrow("sandbox metadata conflicts");
  metadata.sandbox_mode = "danger-full-access";
  body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
  updateRolloutState(databasePath, database => {
    database.query("INSERT INTO thread_spawn_edges VALUES (?, ?, ?)").run(rolloutParentId, rolloutThreadId, "open");
  });
  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request))
    .toThrow("does not authenticate");
});

test.each(["remote", "local"])("%s compaction authenticates the latest native turn as current or source, never an arbitrary ancestor", kind => {
  const { codexHome, request: original, rolloutPath } = resumedRootFixture();
  const body = original._rawBody as { client_metadata: Record<string, string>; input: Array<Record<string, unknown>> };
  const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]!);
  metadata.request_kind = "compaction";
  metadata.turn_id = "01a06c66-ffff-75c6-a0df-318f890ef6de";
  body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
  if (kind === "remote") body.input.push({ type: "compaction_trigger" });
  else body.input.push({ type: "message", role: "user", content: [{ type: "input_text", text: COMPACT_PROMPT }] });
  const request = parseRequest({ ...body, model: "chatgpt-web/pro" });
  expect(request._localCompactionRequest).toBe(kind === "local" ? true : undefined);
  expect(request._compactionRequest).toBe(kind === "remote" ? true : undefined);
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

for (const format of ["v1", "v2"]) for (const groupedPreamble of [false, true]) for (const newInstruction of [false, true]) test(`${format} ${groupedPreamble ? "grouped preamble" : "context-only"} continuation ${newInstruction ? "with a new instruction" : "of the previous instruction"} requires a matching current rollout, not just a checkpoint`, () => {
    const { codexHome, request, rolloutPath } = resumedRootFixture();
    const body = request._rawBody as { input: Array<Record<string, unknown>> };
    const oldTurnId = "01a06c66-0000-75c6-a0df-318f890ef6de";
    body.input[0]!.internal_chat_message_metadata_passthrough = { turn_id: oldTurnId };
    const summary = `Confirmed ${format} checkpoint`;
    rememberCompactionContinuation({ ...request, _compactionRequest: true }, extractChatGptTurnIdentity(request), [
      { turnId: oldTurnId, content: body.input[0]!.content },
    ], summary);
    const environmentPart = { type: "input_text", text: environmentXml };
    const current = {
      type: "message", role: "user", id: "msg_current_environment",
      content: groupedPreamble ? [
        { type: "input_text", text: "<recommended_plugins>Example plugin</recommended_plugins>" },
        { type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>Keep existing changes.</INSTRUCTIONS>" },
        environmentPart,
      ] : [environmentPart],
      internal_chat_message_metadata_passthrough: { turn_id: rolloutTurnId },
    };
    const checkpoint = format === "v2"
      ? { type: "compaction", encrypted_content: encodeCompactionSummary(summary) }
      : { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${summary}` }] };
    // Native compaction rebuilds the current preamble before the earlier user instruction.
    body.input.unshift(current);
    const checkpointIndex = body.input.length;
    body.input.push(checkpoint);
    const nextContent = [{ type: "input_text", text: "Continue with the next requested change" }];
    if (newInstruction) body.input.push({
      type: "message", role: "user", id: "msg_after_compaction", content: nextContent,
      internal_chat_message_metadata_passthrough: { turn_id: rolloutTurnId, content_item_kinds: ["user.text"] },
    });
    const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
    expect(store.resolve(request).cwd).toBe(root);
    if (newInstruction) expect(extractChatGptTurnUserRevision(request)).toEqual(nextContent);
    for (const text of [
      environmentXml.replaceAll(root, resolve(root, "another-workspace")),
      environmentXml.replace('<permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile>',
        '<sandbox_mode>read-only</sandbox_mode>'),
      "<environment_context><cwd/></environment_context>",
    ]) {
      environmentPart.text = text;
      expect(() => store.resolve(request)).toThrow();
    }
    environmentPart.text = environmentXml;
    body.input.splice(checkpointIndex, 1);
    expect(() => store.resolve(request)).toThrow("missing cwd");
    body.input.splice(checkpointIndex, 0, checkpoint);
    writeFileSync(rolloutPath, [
      JSON.stringify({ type: "session_meta", payload: { id: rolloutThreadId, source: "vscode" } }),
      JSON.stringify(childTurnContext(oldTurnId)),
    ].join("\n") + "\n");
    // A valid cached environment and matching wire claim cannot overrule a different native turn.
    expect(() => store.resolve(request)).toThrow("current turn");
  });
test.each(["v1", "v2"])("%s recovered delegation still requires current rollout environment proof", format => {
    const { codexHome, request, rolloutPath } = resumedRootFixture();
    const body = request._rawBody as { input: Array<Record<string, unknown>> };
    const previous = body.input[0]!;
    previous.internal_chat_message_metadata_passthrough = { turn_id: "turn_old_human" };
    const output = "<codex_delegation><source_thread_id>source_thread</source_thread_id><input>Continue the requested audit.</input></codex_delegation>";
    const source = { content: output, itemId: "fco_environment_delegation", turnId: rolloutTurnId };
    body.input.push({ type: "function_call_output", id: source.itemId, name: "send_message_to_thread", namespace: "codex_app",
      output, internal_chat_message_metadata_passthrough: { turn_id: rolloutTurnId } });
    const summary = `Delegation environment checkpoint ${format}`;
    rememberCompactionContinuation({ ...request, _compactionRequest: true }, extractChatGptTurnIdentity(request), [
      source, { content: previous.content, itemId: String(previous.id), turnId: "turn_old_human" },
    ], summary);
    const environmentPart = { type: "input_text", text: environmentXml };
    body.input = [
      { type: "message", role: "user", id: "msg_current_context", content: [environmentPart],
        internal_chat_message_metadata_passthrough: { turn_id: rolloutTurnId } },
      previous,
      format === "v1"
        ? { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${summary}` }] }
        : { type: "compaction", encrypted_content: encodeCompactionSummary(summary) },
    ];
    expect(extractChatGptTurnUserRevision(request)).toBe(output);
    const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
    expect(store.resolve(request).cwd).toBe(root);
    environmentPart.text = environmentXml.replaceAll(root, resolve(root, "unproven-workspace"));
    expect(() => store.resolve(request)).toThrow();
    environmentPart.text = environmentXml;
    rmSync(rolloutPath);
    expect(() => store.resolve(request)).toThrow("Codex has no canonical rollout for the requested root thread");
  });
  for (const shared of [false, true]) for (const format of ["v1", "v2"]) test(`${format} full-access compaction keeps current workspace context when a restart omits native roots (#847, shared=${shared})`, () => {
    const { codexHome, request, rolloutPath } = resumedRootFixture();
    const bridgeHome = shared ? mkdtempSync(join(tmpdir(), "codex-shared-compaction-")) : codexHome;
    if (shared) temporaryRoots.push(bridgeHome);
    const body = request._rawBody as { input: Array<Record<string, unknown>>; client_metadata: Record<string, string> };
    const oldTurnId = "01a06c66-0000-75c6-a0df-318f890ef6de";
    body.input[0]!.internal_chat_message_metadata_passthrough = { turn_id: oldTurnId };
    const summary = `Full-access restart checkpoint ${format} shared=${shared}`;
    rememberCompactionContinuation({ ...request, _compactionRequest: true }, extractChatGptTurnIdentity(request), [
      { turnId: oldTurnId, content: body.input[0]!.content },
    ], summary);
    const auxiliary = join(codexHome, "second-workspace");
    const currentEnvironment = environmentXml.replace(
      "</workspace_roots>", `<root>${auxiliary}</root></workspace_roots>`,
    );
    const environmentPart = { type: "input_text", text: currentEnvironment };
    body.input.unshift({
      type: "message", role: "user", id: "msg_current_environment", content: [environmentPart],
      internal_chat_message_metadata_passthrough: { turn_id: rolloutTurnId },
    });
    body.input.push(format === "v2"
      ? { type: "compaction", encrypted_content: encodeCompactionSummary(summary) }
      : { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${summary}` }] });
    const native = childTurnContext(rolloutTurnId, { workspace_roots: [root, auxiliary] });
    const payload = native.payload as Record<string, unknown>;
    const writeContext = () => writeFileSync(rolloutPath, [
      { type: "session_meta", payload: { id: rolloutThreadId, source: "vscode" } }, native,
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
    const resolveCurrent = () => new ChatGptThreadEnvironmentStore(
      undefined, Date.now, bridgeHome, undefined, shared ? [codexHome] : [],
    ).resolve(request);
    writeContext();
    const beforeRestart = resolveCurrent();
    expect(beforeRestart.roots).toEqual([root, auxiliary]);
    delete payload.workspace_roots;
    writeContext();
    expect(resolveCurrent()).toEqual(beforeRestart);

    // Git metadata may also retain the second workspace. It is not a new grant.
    const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]!);
    metadata.workspaces = { [root]: {}, [auxiliary]: {} };
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
    expect(resolveCurrent()).toEqual(beforeRestart);
    metadata.workspaces = { [root]: {} };
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);

    for (const conflict of [
      currentEnvironment.replaceAll(root, join(codexHome, "different-cwd")),
      currentEnvironment.replace(dangerFullAccessProfileXml, '<permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry></file_system></permission_profile>'),
    ]) {
      environmentPart.text = conflict;
      expect(resolveCurrent).toThrow("environment conflicts");
    }
    environmentPart.text = currentEnvironment;
    // The current envelope cannot omit any explicitly declared native project.
    payload.workspace_roots = [root, auxiliary, join(codexHome, "missing-project")];
    writeContext();
    expect(resolveCurrent).toThrow("environment conflicts");
    payload.workspace_roots = null;
    writeContext();
    expect(resolveCurrent).toThrow();
    delete payload.workspace_roots;
    payload.turn_id = oldTurnId;
    writeContext();
    expect(resolveCurrent).toThrow("current turn");
  });

  for (const shared of [false, true]) for (const format of ["v1", "v2"])
  for (const outputFolder of ["visualizations", "ordinary-results"])
  for (const rootSource of ["session", "turn"]) test(`${format} full-access compaction keeps declared ${rootSource} projects when Codex adds an output root (#933, shared=${shared}, output=${outputFolder})`, () => {
    const { codexHome, request, rolloutPath } = resumedRootFixture();
    const bridgeHome = shared ? mkdtempSync(join(tmpdir(), "codex-shared-added-root-")) : codexHome;
    if (shared) temporaryRoots.push(bridgeHome);
    const body = request._rawBody as { input: Array<Record<string, unknown>>; client_metadata: Record<string, string> };
    const oldTurnId = "01a06c66-0000-75c6-a0df-318f890ef6de";
    body.input[0]!.internal_chat_message_metadata_passthrough = { turn_id: oldTurnId };
    const summary = `Added workspace checkpoint ${format} ${rootSource} shared=${shared}`;
    rememberCompactionContinuation({ ...request, _compactionRequest: true }, extractChatGptTurnIdentity(request), [
      { turnId: oldTurnId, content: body.input[0]!.content },
    ], summary);
    const auxiliary = join(codexHome, "second-project");
    const output = join(codexHome, outputFolder, "2026", "10", "22", rolloutThreadId);
    const roots = [root, auxiliary];
    const currentEnvironment = (claimedRoots: string[]) => environmentXml.replace(
      /<workspace_roots>[\s\S]*?<\/workspace_roots>/,
      `<workspace_roots>${claimedRoots.map(path => `<root>${path}</root>`).join("")}</workspace_roots>`,
    );
    // The native project order remains stable even when the current envelope adds
    // a visualization directory first. No directory name grants special access.
    const environmentPart = { type: "input_text", text: currentEnvironment([output, auxiliary, root]) };
    body.input.unshift({
      type: "message", role: "user", id: "msg_current_environment", content: [environmentPart],
      internal_chat_message_metadata_passthrough: { turn_id: rolloutTurnId },
    });
    body.input.push(format === "v2"
      ? { type: "compaction", encrypted_content: encodeCompactionSummary(summary) }
      : { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${summary}` }] });
    const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]!);
    metadata.workspaces = Object.fromEntries(roots.map(path => [path, {}]));
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
    const session = { type: "session_meta", payload: {
      id: rolloutThreadId, source: "vscode", ...(rootSource === "session" ? { runtime_workspace_roots: roots } : {}),
    } };
    const native = childTurnContext(rolloutTurnId, {
      workspace_roots: rootSource === "turn" ? roots : undefined,
    });
    const payload = native.payload as Record<string, unknown>;
    const writeContext = () => writeFileSync(rolloutPath,
      [session, native].map(value => JSON.stringify(value)).join("\n") + "\n");
    const state = join(bridgeHome, "thread-environments.json");
    const resolveCurrent = () => new ChatGptThreadEnvironmentStore(
      state, Date.now, bridgeHome, undefined, shared ? [codexHome] : [],
    ).resolve(request);
    writeContext();
    const expected = {
      cwd: root, roots: [...roots, output], writableRoots: [...roots, output],
      sandboxPolicy: { type: "dangerFullAccess" as const }, tools: request.context.tools ?? [],
    };
    expect(resolveCurrent()).toEqual(expected);
    expect(resolveCurrent()).toEqual(expected);

    for (const claimed of [[root, output], [root, join(codexHome, "replacement-project"), output]]) {
      environmentPart.text = currentEnvironment(claimed);
      expect(resolveCurrent).toThrow("environment conflicts");
    }
    environmentPart.text = currentEnvironment([output, auxiliary, root]).replace(
      `<cwd>${root}</cwd>`, `<cwd>${auxiliary}</cwd>`,
    );
    expect(resolveCurrent).toThrow("environment conflicts");
    environmentPart.text = currentEnvironment([output, auxiliary, root]).replace(
      dangerFullAccessProfileXml, readOnlyProfileXml,
    );
    expect(resolveCurrent).toThrow("environment conflicts");
    environmentPart.text = currentEnvironment([output, auxiliary, root]);
    payload.turn_id = oldTurnId;
    writeContext();
    expect(resolveCurrent).toThrow("current turn");
    payload.turn_id = rolloutTurnId;
    writeContext();
    expect(resolveCurrent()).toEqual(expected);
    rmSync(rolloutPath);
    expect(resolveCurrent).toThrow();
  });


test("compaction keeps current native output-directory grants omitted from workspace roots", () => {
    const { codexHome, request, rolloutPath } = resumedRootFixture();
    const body = request._rawBody as { input: Array<Record<string, unknown>>; client_metadata: Record<string, string> };
    const oldTurnId = "01a06c66-0000-75c6-a0df-318f890ef6de";
    body.input[0]!.internal_chat_message_metadata_passthrough = { turn_id: oldTurnId };
    const summary = "Confirmed output-directory checkpoint";
    rememberCompactionContinuation({ ...request, _compactionRequest: true }, extractChatGptTurnIdentity(request), [
      { turnId: oldTurnId, content: body.input[0]!.content },
    ], summary);
    const environmentPart = { type: "input_text", text: filesystemEnvironmentXml(workspaceWriteProfileXml) };
    body.input.unshift({
      type: "message", role: "user", id: "msg_current_environment", content: [environmentPart],
      internal_chat_message_metadata_passthrough: { turn_id: rolloutTurnId },
    });
    body.input.push({ type: "compaction", encrypted_content: encodeCompactionSummary(summary) });
    const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]!);
    metadata.sandbox_mode = "workspace-write";
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
    const output = join(codexHome, "native-output");
    const entries = [
      { path: { type: "special", value: { kind: "root" } }, access: "read" },
      ...[root, output].map(path => ({ path: { type: "path", path }, access: "write" })),
      { path: { type: "special", value: { kind: "slash_tmp" } }, access: "write" },
      { path: { type: "special", value: { kind: "tmpdir" } }, access: "write" },
    ];
    writeFileSync(rolloutPath, [
      { type: "session_meta", payload: { id: rolloutThreadId, source: "vscode" } },
      childTurnContext(rolloutTurnId, {
        sandbox_policy: { type: "workspace-write", writable_roots: [output], network_access: true },
        permission_profile: { type: "managed", file_system: { type: "restricted", entries }, network: "enabled" },
        file_system_sandbox_policy: { kind: "restricted", entries },
      }),
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
    const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
    expect(store.resolve(request)).toMatchObject({
      cwd: root, roots: [root], writableRoots: [root, output],
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [root, output], networkAccess: true },
    });
    const original = environmentPart.text;
    for (const conflicting of [
      original.replaceAll(root, join(codexHome, "unproven-project")),
      original.replace("</workspace_roots>", `<root>${join(codexHome, "unproven-output")}</root></workspace_roots>`),
      original.replace("<filesystem>", "<network_access>restricted</network_access><filesystem>"),
      filesystemEnvironmentXml(readOnlyProfileXml),
    ]) {
      environmentPart.text = conflicting;
      expect(() => store.resolve(request)).toThrow("environment conflicts");
    }
  });

function filesystemEnvironmentXml(permissionProfileXml: string): string {
  return `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots>${permissionProfileXml}</filesystem>
</environment_context>`;
}

const workspaceWriteProfileXml = `<permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry><entry access="write"><path>${root}</path></entry><entry access="write"><special>:slash_tmp</special></entry><entry access="write"><special>:tmpdir</special></entry><entry access="read"><path>${root}/.git</path></entry></file_system></permission_profile>`;
const readOnlyProfileXml = `<permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry></file_system></permission_profile>`;

function cwdlessRolloutFixture(mode: "workspace-write" | "danger-full-access" = "workspace-write", attributed = true) {
    const fixture = resumedRootFixture();
    const roots = [dirname(root), root, join(fixture.codexHome, "visualizations")];
    const profile = mode === "workspace-write"
      ? `<permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry>${roots.map(path => `<entry access="write"><path>${path}</path></entry>`).join("")}</file_system></permission_profile>`
      : dangerFullAccessProfileXml;
    const environment = {
      type: "message", role: "user", id: "msg_cwdless_environment",
      ...(attributed ? { internal_chat_message_metadata_passthrough: { turn_id: rolloutTurnId } } : {}),
      content: [{ type: "input_text", text: `<environment_context>
  <current_date>2026-10-22</current_date><timezone>Asia/Shanghai</timezone>
  <filesystem><workspace_roots>${roots.map(path => `<root>${path}</root>`).join("")}</workspace_roots>${profile}</filesystem>
</environment_context>` }],
    };
    const body = fixture.request._rawBody as { client_metadata: Record<string, string>; input: Array<Record<string, unknown>> };
    const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]!);
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ ...metadata, sandbox_mode: mode });
    body.input.unshift(environment);
    const nativeContext = childTurnContext(rolloutTurnId, {
      workspace_roots: roots,
      sandbox_policy: mode === "workspace-write"
        ? { type: mode, writable_roots: roots, network_access: true }
        : { type: mode },
      permission_profile: mode === "workspace-write"
        ? { type: "managed", file_system: { type: "restricted", entries: [
          { path: { type: "special", value: { kind: "root" } }, access: "read" },
          ...roots.map(path => ({ path: { type: "path", path }, access: "write" })),
          { path: { type: "special", value: { kind: "slash_tmp" } }, access: "write" },
          { path: { type: "special", value: { kind: "tmpdir" } }, access: "write" },
        ] }, network: "enabled" }
        : { type: "disabled" },
    });
    const writeContext = () => writeFileSync(fixture.rolloutPath, [
      { type: "session_meta", payload: { id: rolloutThreadId, source: "vscode" } },
      nativeContext,
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
    writeContext();
    return { ...fixture, request: parseRequest({ ...body, model: "chatgpt-web/high" }), environment, roots, nativeContext, writeContext };
  }

function worktreeRolloutFixture() {
    const fixture = resumedRootFixture();
    const roots = [join(fixture.codexHome, "project"), join(fixture.codexHome, "visualizations")];
    const request = environmentlessChild();
    const body = request._rawBody as { client_metadata: Record<string, string>; input: Array<Record<string, unknown>> };
    const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]!);
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ ...metadata, agent_name: "/root" });
    const envelope = {
      type: "message", role: "user", id: "msg_worktree_environment",
      internal_chat_message_metadata_passthrough: { turn_id: rolloutTurnId },
      content: [{ type: "input_text", text: `<environment_context><cwd>${root}</cwd><filesystem><workspace_roots>${roots.map(path => `<root>${path}</root>`).join("")}</workspace_roots>${dangerFullAccessProfileXml}</filesystem></environment_context>` }],
    };
    body.input.unshift(envelope);
    // Captured Codex Desktop 0.164 V1 shape: the worktree cwd is current, project
    // roots are retained in session_meta, and the turn explicitly has Full Access.
    const session = childSessionMeta();
    const sessionPayload = session.payload as Record<string, any>;
    delete sessionPayload.agent_path;
    sessionPayload.source.subagent.thread_spawn.agent_path = null;
    sessionPayload.runtime_workspace_roots = roots;
    const context = childTurnContext();
    delete (context.payload as Record<string, unknown>).workspace_roots;
    const writeContext = () => writeFileSync(fixture.rolloutPath,
      [session, context].map(value => JSON.stringify(value)).join("\n") + "\n");
    writeContext();
    return { ...fixture, request, roots, envelope, sessionPayload, context, writeContext };
  }

test("Full Access worktree cwd uses its current native session's project roots", () => {
    const { request, codexHome, roots } = worktreeRolloutFixture();
    expect(() => extractChatGptTurnEnvironment(request)).toThrow();
    const state = join(codexHome, "thread-environments.json");
    const expected = { cwd: root, roots, writableRoots: roots, sandboxPolicy: { type: "dangerFullAccess" as const }, tools: [] };
    expect(new ChatGptThreadEnvironmentStore(state, Date.now, codexHome).resolve(request)).toEqual(expected);
    expect(new ChatGptThreadEnvironmentStore(state, Date.now, codexHome).resolve(request)).toEqual(expected);
  });

test("worktree context cannot replace native cwd, project roots, lineage, or the current turn", () => {
    for (const conflict of ["cwd", "roots", "parent", "turn", "missing-roots", "malformed-roots", "restricted-profile", "restricted-sandbox", "missing-sandbox", "split-policy"] as const) {
      const fixture = worktreeRolloutFixture();
      const payload = fixture.context.payload as Record<string, unknown>;
      if (conflict === "cwd") payload.cwd = join(root, "different-worktree");
      if (conflict === "roots") fixture.sessionPayload.runtime_workspace_roots = [join(fixture.codexHome, "different-project")];
      if (conflict === "parent") fixture.sessionPayload.parent_thread_id = "01a06c66-ffff-75c6-a0df-318f890ef6de";
      if (conflict === "turn") payload.turn_id = "01a06c66-ffff-75c6-a0df-318f890ef6de";
      if (conflict === "missing-roots") delete fixture.sessionPayload.runtime_workspace_roots;
      if (conflict === "malformed-roots") fixture.sessionPayload.runtime_workspace_roots = ["relative-project"];
      if (conflict === "restricted-profile") payload.permission_profile = { type: "managed" };
      if (conflict === "restricted-sandbox") payload.sandbox_policy = { type: "read-only", network_access: false };
      if (conflict === "missing-sandbox") delete payload.sandbox_policy;
      if (conflict === "split-policy") payload.file_system_sandbox_policy = { kind: "restricted", entries: [] };
      fixture.writeContext();
      expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, fixture.codexHome).resolve(fixture.request)).toThrow();
    }
  });

test("current turn roots override the worktree session's original roots", () => {
    const fixture = worktreeRolloutFixture();
    (fixture.context.payload as Record<string, unknown>).workspace_roots = fixture.roots;
    fixture.sessionPayload.runtime_workspace_roots = [join(fixture.codexHome, "previous-project")];
    fixture.writeContext();
    expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, fixture.codexHome).resolve(fixture.request))
      .toMatchObject({ cwd: root, roots: fixture.roots });
  });

test("worktree context cannot borrow cached Full Access when current native evidence is absent", () => {
    const { request, codexHome, rolloutPath } = worktreeRolloutFixture();
    const state = join(codexHome, "thread-environments.json");
    expect(new ChatGptThreadEnvironmentStore(state, Date.now, codexHome).resolve(request).cwd).toBe(root);
    rmSync(rolloutPath);
    expect(() => new ChatGptThreadEnvironmentStore(state, Date.now, codexHome).resolve(request)).toThrow();
  });

test("an outside-root worktree does not widen restricted permissions", () => {
    const { request, codexHome, envelope, context, writeContext } = worktreeRolloutFixture();
    envelope.content[0]!.text = envelope.content[0]!.text.replace(dangerFullAccessProfileXml, readOnlyProfileXml);
    const payload = context.payload as Record<string, unknown>;
    payload.permission_profile = { type: "managed" };
    payload.sandbox_policy = { type: "read-only", network_access: false };
    writeContext();
    expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request)).toThrow();
  });

test.each([true, false])("cwd-less workspace update uses the current rollout cwd, not the first root; attributed=%s (#894)", attributed => {
    const { codexHome, request, roots } = cwdlessRolloutFixture("workspace-write", attributed);
    const writableRoots = [root, ...roots.filter(path => path !== root)];
    expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request)).toEqual({
      cwd: root, roots, writableRoots,
      sandboxPolicy: { type: "workspaceWrite", writableRoots, networkAccess: true }, tools: [],
    });
  });

test("cwd-less unrestricted updates require current native cwd regardless of root order (#894)", () => {
    const { codexHome, request, environment, roots, nativeContext, writeContext } = cwdlessRolloutFixture("danger-full-access");
    const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
    expect(store.resolve(request)).toMatchObject({ cwd: root, roots });
    const original = environment.content[0]!.text;
    const reordered = [roots[2]!, roots[0]!, root];
    environment.content[0]!.text = original.replace(/<workspace_roots>[\s\S]*?<\/workspace_roots>/,
      `<workspace_roots>${reordered.map(path => `<root>${path}</root>`).join("")}</workspace_roots>`);
    expect(store.resolve(request)).toMatchObject({ cwd: root, roots });
    // Native unrestricted records can omit roots; current workspace context is
    // still retained, but it must contain the native cwd.
    delete (nativeContext.payload as Record<string, unknown>).workspace_roots;
    writeContext();
    expect(store.resolve(request)).toMatchObject({ cwd: root, roots: reordered });
    environment.content[0]!.text = original.replaceAll(dirname(root), join(codexHome, "unrelated"));
    expect(() => store.resolve(request)).toThrow("environment conflicts");
  });

test.each(["workspace-write", "danger-full-access"] as const)("cwd-less %s cannot use cached authority or an earlier turn (#894)", mode => {
    const { codexHome, request, rolloutPath, nativeContext, writeContext } = cwdlessRolloutFixture(mode);
    const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
    expect(store.resolve(request).cwd).toBe(root);
    (nativeContext.payload as Record<string, unknown>).turn_id = "01a06c66-ffff-75c6-a0df-318f890ef6de";
    writeContext();
    expect(() => store.resolve(request)).toThrow("current turn");
    rmSync(rolloutPath);
    expect(() => store.resolve(request)).toThrow("no canonical rollout");
  });

test("cwd-less updates still reject conflicting explicit cwd, permissions and roots (#894)", () => {
    const { codexHome, request, environment } = cwdlessRolloutFixture();
    const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
    expect(store.resolve(request).cwd).toBe(root);
    const original = environment.content[0]!.text;
    for (const [text, field] of [
      [original.replace("<filesystem>", `<cwd>${dirname(root)}</cwd><filesystem>`), "cwd"],
      [original.replace("</workspace_roots>", `<root>${join(codexHome, "unproven")}</root></workspace_roots>`), "workspace_roots"],
      [original.replace("<filesystem>", "<network_access>restricted</network_access><filesystem>"), "network_access"],
      [original.replace(/<permission_profile[\s\S]*?<\/permission_profile>/, readOnlyProfileXml), "sandbox_policy"],
    ]) {
      environment.content[0]!.text = text!;
      expect(() => store.resolve(request), `conflicting ${field}`).toThrow("environment conflicts");
    }
  });

test("an untagged cwd-less claim must remain adjacent to the current instruction and match native roots", () => {
    const { codexHome, request, environment } = cwdlessRolloutFixture("workspace-write", false);
    const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
    expect(store.resolve(request).cwd).toBe(root);
    const body = request._rawBody as { input: Array<Record<string, unknown>> };
    const original = structuredClone(body.input);
    for (const [index, invalid] of [
      [original[1]!, original[0]!],
      [{ ...original[0], id: undefined }, original[1]!],
    ].entries()) {
      body.input = invalid;
      expect(() => store.resolve(request), `unproven claim ${index}`).toThrow();
    }
    body.input = [environment, original[1]!];
    const text = environment.content[0]!.text;
    environment.content[0]!.text = text.replaceAll(dirname(root), join(codexHome, "unproven"));
    expect(() => store.resolve(request)).toThrow("environment conflicts");
    environment.content[0]!.text = text;
    expect(store.resolve(request).cwd).toBe(root);
    body.input[0] = { ...environment, internal_chat_message_metadata_passthrough: { turn_id: rolloutParentId },
      content: [{ type: "input_text", text: text.replaceAll(dirname(root), join(codexHome, "historical")) }] };
    expect(store.resolve(request).cwd).toBe(root);
    body.input[1] = { ...original[1], internal_chat_message_metadata_passthrough: { turn_id: rolloutParentId } };
    expect(() => extractChatGptTurnUserRevision(request)).toThrow("conflicts with native Codex turn_id");
  });

test("malformed cwd-less updates cannot borrow a valid native environment (#894)", () => {
    const { codexHome, request, environment } = cwdlessRolloutFixture();
    const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
    expect(store.resolve(request).cwd).toBe(root);
    const original = environment.content[0]!.text;
    for (const text of [
      original.replace("<filesystem>", "<cwd/><filesystem>"),
      original.replace("<workspace_roots>", "<workspace_roots><root/>"),
      original.replace("</workspace_roots>", "</workspace_roots><workspace_roots>"),
      original.replace("<filesystem>", "<environments></environments><filesystem>"),
    ]) {
      environment.content[0]!.text = text;
      expect(() => store.resolve(request)).toThrow("missing cwd");
    }
  });
