import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseRequest } from "../src/responses/parser";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";

const threadId = "01a14546-fe57-74c2-b66f-86c4ed016b87";
const turnId = "01a1454c-61e4-7bf2-9d1f-1c4d0495eb1f";
const parentId = "01a14546-fe57-74c2-b66f-86c4ed016b88";
const foreignId = "01a14546-fe57-74c2-b66f-86c4ed016b89";
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function fixture(actor: "root" | "child", readOnly = false) {
  const codexHome = mkdtempSync(join(tmpdir(), "cgw-viz-authority-"));
  homes.push(codexHome);
  const workspace = join(codexHome, "workspace");
  const agent = "/root/visualization-check";
  const metadata = {
    request_kind: "turn", thread_id: threadId, turn_id: turnId,
    sandbox_mode: readOnly ? "read-only" : "danger-full-access", workspaces: { [workspace]: {} },
    ...(actor === "child" ? { parent_thread_id: parentId, agent_name: agent, subagent_kind: "thread_spawn" } : {}),
  };
  const entries = [{ path: { type: "special", value: { kind: "root" } }, access: "read" }];
  // Codex 0.163 emits this authoritative record without workspace_roots.
  const turn = {
    turn_id: turnId, cwd: workspace, approval_policy: "never",
    sandbox_policy: readOnly ? { type: "read-only", network_access: true } : { type: "danger-full-access" },
    permission_profile: readOnly
      ? { type: "managed", file_system: { type: "restricted", entries }, network: "enabled" }
      : { type: "disabled" },
    ...(readOnly ? { file_system_sandbox_policy: { kind: "restricted", entries } } : {}),
  };
  const rollout = join(codexHome, "sessions", "2026", "10", "16", `rollout-2026-10-16T23-19-55-${threadId}.jsonl`);
  mkdirSync(dirname(rollout), { recursive: true });
  const session = actor === "child" ? {
    id: threadId, parent_thread_id: parentId, agent_path: agent, thread_source: "subagent",
    source: { subagent: { thread_spawn: { parent_thread_id: parentId, agent_path: agent } } },
  } : { id: threadId, source: "vscode" };
  writeFileSync(rollout, [
    { type: "session_meta", payload: session }, { type: "turn_context", payload: turn },
  ].map(item => JSON.stringify(item)).join("\n") + "\n");
  const visualization = (id = threadId) => join(codexHome, "visualizations", "2026", "10", "16", id);
  const request = (extraRoot: string, cwd = workspace) => parseRequest({
    model: "chatgpt-web/gpt-6-sol-instant", reasoning: { effort: "low" },
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
    input: [{
      type: "message", id: "native_environment", role: "user",
      content: [{ type: "input_text", text: `<environment_context><cwd>${cwd}</cwd><current_date>2026-10-16</current_date><filesystem><workspace_roots><root>${workspace}</root><root>${extraRoot}</root></workspace_roots>${readOnly
        ? "<sandbox_mode>read-only</sandbox_mode><network_access>enabled</network_access>"
        : '<permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile>'}</filesystem></environment_context>` }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    }, {
      type: "message", id: "native_instruction", role: "user",
      content: [{ type: "input_text", text: "Please introduce yourself." }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    }],
  });
  return { codexHome, workspace, visualization, request };
}

test.each(["root", "child"] as const)("%s tolerates its exact visualization root without replacing canonical authority", actor => {
  const f = fixture(actor);
  const parsed = f.request(f.visualization());
  const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, f.codexHome);
  const expected = { cwd: f.workspace, roots: [f.workspace], writableRoots: [f.workspace], sandboxPolicy: { type: "dangerFullAccess" } };
  expect(store.resolve(parsed)).toMatchObject(expected);
  expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, f.codexHome).resolve(parsed)).toMatchObject(expected);
  (parsed._rawBody as { input: unknown[] }).input.shift();
  expect(store.resolve(parsed)).toMatchObject(expected);
});

test("a verified child may carry its parent visualization root", () => {
  const f = fixture("child");
  expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, f.codexHome).resolve(f.request(f.visualization(parentId))).roots)
    .toEqual([f.workspace]);
});

test("explicit network context still compares writable roots without granting the auxiliary path", () => {
  const f = fixture("root");
  const parsed = f.request(f.visualization());
  const body = parsed._rawBody as { input: Array<{ content: Array<{ text: string }> }> };
  body.input[0]!.content[0]!.text = body.input[0]!.content[0]!.text.replace("</filesystem>", "<network_access>enabled</network_access></filesystem>");
  expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, f.codexHome).resolve(parsed).writableRoots)
    .toEqual([f.workspace]);
});

test("unverified parent metadata cannot authorize another thread's visualization root", () => {
  const f = fixture("child");
  const parsed = f.request(f.visualization(foreignId));
  const body = parsed._rawBody as { client_metadata: Record<string, string> };
  const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]!);
  metadata.parent_thread_id = foreignId;
  body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, f.codexHome).resolve(parsed))
    .toThrow("session metadata");
});

test.each(["root", "child"] as const)("%s still rejects unknown, foreign, descendant and outside-home roots", actor => {
  const f = fixture(actor);
  for (const extra of [join(f.workspace, "extra"), f.visualization(foreignId), join(f.visualization(), "child"),
    join(f.codexHome, "outside", "visualizations", "2026", "10", "16", threadId),
    join(f.codexHome, "visualizations", "2026", "99", "16", threadId),
    join(f.visualization(), "..", foreignId), ...(actor === "root" ? [f.visualization(parentId)] : [])]) {
    expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, f.codexHome).resolve(f.request(extra)), extra)
      .toThrow("current Codex rollout");
  }
  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, f.codexHome)
    .resolve(f.request(f.visualization(), join(f.workspace, "other")))).toThrow();
});

test("visualization compatibility does not relax restricted workspace authority", () => {
  const f = fixture("root", true);
  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, f.codexHome).resolve(f.request(f.visualization())))
    .toThrow("current Codex rollout");
});

test("calendar refreshes apply the same bounded visualization compatibility", () => {
  const f = fixture("root");
  const parsed = f.request(f.workspace);
  const input = (parsed._rawBody as { input: Array<Record<string, unknown>> }).input;
  const refresh = (extra: string) => ({ type: "message", id: "calendar_refresh", role: "user",
    content: [{ type: "input_text", text: `<environment_context><current_date>2026-10-17</current_date><filesystem><workspace_roots><root>${f.workspace}</root><root>${extra}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>` }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });
  input.push(refresh(f.visualization()));
  const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, f.codexHome);
  expect(store.resolve(parsed).roots).toEqual([f.workspace]);
  input[input.length - 1] = refresh(f.visualization(foreignId));
  expect(() => store.resolve(parsed)).toThrow("current Codex rollout");
});
