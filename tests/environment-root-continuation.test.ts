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
