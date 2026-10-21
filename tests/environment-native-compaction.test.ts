import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ChatGptThreadEnvironmentStore } from '../src/adapters/chatgpt-web/thread-environment';
import type { CodexParsedRequest } from '../src/types';
import { parseRequest } from '../src/responses/parser';
import { encodeCompactionSummary } from '../src/responses/compaction';
import { root, currentWire, environmentXml, dangerFullAccessProfileXml } from './environment-fixture';
const temporaryRoots: string[] = [];
afterEach(() => { for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const rolloutThreadId = "01a06c66-4232-7ae1-9108-69b5f70e0671";

const rolloutTurnId = "01a06c66-4380-75c6-a0df-318f890ef6de";

const rolloutParentId = "01a06c66-18ad-73e1-a641-9b114f2ed10c";

const rolloutAgent = "/root/rollout_child";

const workspaceWriteProfileXml = `<permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry><entry access="write"><path>${root}</path></entry><entry access="write"><special>:slash_tmp</special></entry><entry access="write"><special>:tmpdir</special></entry><entry access="read"><path>${root}/.git</path></entry></file_system></permission_profile>`;

const readOnlyProfileXml = `<permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry></file_system></permission_profile>`;

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

function midnightRolloutFixture() {
    const fixture = resumedRootFixture();
    const body = fixture.request._rawBody as { input: Array<Record<string, unknown>>; client_metadata: Record<string, string> };
    const delta = {
      type: "message", role: "user", id: "msg_calendar_delta",
      internal_chat_message_metadata_passthrough: { turn_id: rolloutTurnId },
      content: [{ type: "input_text", text: `<environment_context>
  <current_date>2026-09-19</current_date>
  <timezone>Asia/Shanghai</timezone>
  <filesystem>${dangerFullAccessProfileXml}</filesystem>
</environment_context>` }],
    };
    body.input.push(
      { type: "function_call", id: "fc_midnight", call_id: "call_midnight", name: "fixture", arguments: "{}" },
      { type: "function_call_output", call_id: "call_midnight", output: "done" },
      delta,
    );
    return { ...fixture, request: parseRequest({ ...body, model: "chatgpt-web/pro" }), body, delta };
  }

function managedMidnightFixture(mode: "workspace-write" | "read-only", networkAccess: boolean) {
    const fixture = midnightRolloutFixture();
    const { body, delta, rolloutPath } = fixture;
    delta.content[0]!.text = delta.content[0]!.text.replace(dangerFullAccessProfileXml,
      mode === "workspace-write" ? workspaceWriteProfileXml : readOnlyProfileXml);
    const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]!);
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ ...metadata, sandbox_mode: mode });
    const entries = [
      { path: { type: "special", value: { kind: "root" } }, access: "read" },
      ...(mode === "workspace-write" ? [
        { path: { type: "path", path: root }, access: "write" },
        { path: { type: "special", value: { kind: "slash_tmp" } }, access: "write" },
        { path: { type: "special", value: { kind: "tmpdir" } }, access: "write" },
        { path: { type: "path", path: `${root}/.git` }, access: "read" },
      ] : []),
    ];
    writeFileSync(rolloutPath, [
      { type: "session_meta", payload: { id: rolloutThreadId, source: "vscode" } },
      childTurnContext(rolloutTurnId, {
        sandbox_policy: { type: mode, network_access: networkAccess },
        permission_profile: { type: "managed", file_system: { type: "restricted", entries }, network: networkAccess ? "enabled" : "restricted" },
        file_system_sandbox_policy: { kind: "restricted", entries },
      }),
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
    return fixture;
  }

for (const mode of ["workspace-write", "read-only"] as const) for (const networkAccess of [false, true]) {
    test(`managed midnight delta preserves native ${mode} authority and network=${networkAccess} (#861)`, () => {
      const { codexHome, request, delta } = managedMidnightFixture(mode, networkAccess);
      const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
      for (const repeatRoots of [false, true]) {
        if (repeatRoots) delta.content[0]!.text = delta.content[0]!.text.replace("<filesystem>",
          `<filesystem><workspace_roots><root>${root}</root></workspace_roots>`);
        const actual = store.resolve(request);
        expect(actual.cwd).toBe(root);
        expect(actual.roots).toEqual([root]);
        expect(actual.sandboxPolicy).toMatchObject({ type: mode === "workspace-write" ? "workspaceWrite" : "readOnly", networkAccess });
        expect(actual.writableRoots).toEqual(mode === "workspace-write" ? [root] : []);
      }
    });
  }

test("managed midnight updates reject changed grants, protections and malformed profiles", () => {
    const { codexHome, request, delta } = managedMidnightFixture("workspace-write", false);
    const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
    const original = delta.content[0]!.text;
    expect(store.resolve(request).cwd).toBe(root);
    for (const invalid of [
      original.replace(`<entry access="write"><path>${root}</path>`, `<entry access="write"><path>${resolve(root, "other")}</path>`),
      original.replace(`<path>${root}/.git</path>`, `<path>${root}/protected</path>`),
      original.replace(`<entry access="read"><path>${root}/.git</path>`, `<entry access="write"><path>${root}/.git</path>`),
      original.replace("<special>:tmpdir</special>", "<special>:unknown</special>"),
      original.replace("<filesystem>", `<filesystem><workspace_roots><root>${resolve(root, "other")}</root></workspace_roots>`),
      original.replace(workspaceWriteProfileXml, readOnlyProfileXml),
      original.replace("</file_system>", "<extra/></file_system>"),
      original.replace("</permission_profile>", "<network>enabled</network></permission_profile>"),
    ]) {
      delta.content[0]!.text = invalid;
      expect(() => store.resolve(request)).toThrow();
    }
    delta.content[0]!.text = original;
    expect(store.resolve(request).cwd).toBe(root);
  });

test("managed midnight updates match Codex's rendered workspace aliases and restrictive entries", () => {
    const { codexHome, request, delta, rolloutPath } = managedMidnightFixture("workspace-write", false);
    const records = readFileSync(rolloutPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const context = records[1].payload;
    const fs = context.permission_profile.file_system;
    fs.entries[1].path = { type: "special", value: { kind: "project_roots" } };
    fs.entries[4].missing_path_behavior = "skip";
    fs.entries.push(structuredClone(fs.entries[4]));
    fs.entries.push({ access: "deny", path: { type: "glob_pattern", pattern: `${root}/private & secrets/**` } });
    fs.glob_scan_max_depth = 8;
    context.file_system_sandbox_policy = { kind: "restricted", entries: fs.entries, glob_scan_max_depth: 8 };
    writeFileSync(rolloutPath, records.map(value => JSON.stringify(value)).join("\n") + "\n");
    delta.content[0]!.text = delta.content[0]!.text
      .replace('<file_system type="restricted">', '<file_system type="restricted" glob_scan_max_depth="8">')
      .replace("</file_system>", `<entry access="deny" escalatable="false"><glob>${root}/private &amp; secrets/**</glob></entry></file_system>`);
    const valid = delta.content[0]!.text;
    const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
    expect(store.resolve(request).sandboxPolicy).toMatchObject({ type: "workspaceWrite", networkAccess: false });
    for (const invalid of [
      valid.replace('glob_scan_max_depth="8"', 'glob_scan_max_depth="9"'),
      valid.replace('escalatable="false"', 'escalatable="true"'),
      valid.replace("private &amp; secrets", "other"),
      valid.replace(`<entry access="read"><path>${root}/.git</path></entry>`, ""),
    ]) {
      delta.content[0]!.text = invalid;
      expect(() => store.resolve(request)).toThrow();
    }
  });

test("managed midnight recovery requires the exact current native record even after caching it", () => {
    const { codexHome, request, rolloutPath } = managedMidnightFixture("workspace-write", false);
    const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
    expect(store.resolve(request).cwd).toBe(root);
    const native = readFileSync(rolloutPath, "utf8");
    rmSync(rolloutPath);
    expect(() => store.resolve(request)).toThrow("no canonical rollout");
    for (const stale of [native.replaceAll(rolloutTurnId, rolloutParentId), native.replaceAll(rolloutThreadId, rolloutParentId)]) {
      writeFileSync(rolloutPath, stale);
      expect(() => store.resolve(request)).toThrow();
    }
    writeFileSync(rolloutPath, native);
    expect(store.resolve(request).cwd).toBe(root);
  });

for (const shape of ["plain", "grouped-tagged", "grouped-untagged"] as const)
  test.each(["opaque-native-checkpoint", encodeCompactionSummary("unrecorded bridge checkpoint")])(
    `pre-turn compaction proves its ${shape} environment through native replacement history (%s)`, checkpointText => {
      const { codexHome, request, rolloutPath } = resumedRootFixture();
      const body = request._rawBody as { input: Array<Record<string, unknown>> };
      const previous = body.input[0]!;
      previous.internal_chat_message_metadata_passthrough = { turn_id: rolloutParentId };
      const environmentPart = { type: "input_text", text: environmentXml };
      const current = {
        type: "message", role: "user", id: "msg_native_compacted_environment",
        content: shape === "plain" ? [environmentPart] : [
          { type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>Preserve existing work.</INSTRUCTIONS>" },
          environmentPart,
        ],
        internal_chat_message_metadata_passthrough: {
          turn_id: rolloutTurnId, content_item_kinds: shape === "plain"
            ? ["environments.environment_context"] : ["agents_md.instructions", "environments.environment_context"],
        },
      };
      const checkpoint = {
        type: "compaction", id: "cmp_native_checkpoint", encrypted_content: checkpointText,
        ...(shape === "grouped-tagged" ? { internal_chat_message_metadata_passthrough: { turn_id: rolloutTurnId } } : {}),
      };
      const developerUpdates = shape === "grouped-untagged"
        ? ["tools.deferred_namespaces", "additional_content.codex_apps_client_time_context"].map((kind, i) => ({
          type: "message", role: "developer", id: `msg_developer_update_${i}`,
          content: [{ type: "input_text", text: `Native ${kind} update` }],
          internal_chat_message_metadata_passthrough: { turn_id: rolloutTurnId, content_item_kinds: [kind] },
        })) : [];
      body.input = [current, previous, checkpoint, ...developerUpdates, {
        type: "message", role: "user", id: "msg_next_instruction",
        content: [{ type: "input_text", text: "Continue after native compaction" }],
        internal_chat_message_metadata_passthrough: { turn_id: rolloutTurnId, content_item_kinds: ["user.text"] },
      }];
      const session = { type: "session_meta", payload: { id: rolloutThreadId, source: "vscode" } };
      const compacted = { type: "compacted", payload: { replacement_history: structuredClone([current, previous, checkpoint]) } };
      const native = [session, compacted, childTurnContext()].map(value => JSON.stringify(value)).join("\n") + "\n";
      writeFileSync(rolloutPath, native);
      const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
      expect(store.resolve(request).cwd).toBe(root);

      // An existing cache or a copied checkpoint cannot authenticate altered current context.
      environmentPart.text = `${environmentXml}\n`;
      expect(() => store.resolve(request)).toThrow("native compaction");
      environmentPart.text = environmentXml;
      checkpoint.encrypted_content = "different checkpoint";
      expect(() => store.resolve(request)).toThrow("native compaction");
      checkpoint.encrypted_content = checkpointText;
      body.input.push({ ...current, id: "msg_extra_environment" });
      expect(() => store.resolve(request)).toThrow();
      body.input.pop();
      writeFileSync(rolloutPath, native.replaceAll(rolloutTurnId, rolloutParentId));
      expect(() => store.resolve(request)).toThrow("current turn");
      writeFileSync(rolloutPath, [session, childTurnContext()].map(value => JSON.stringify(value)).join("\n") + "\n");
      expect(() => store.resolve(request)).toThrow("native compaction");
      writeFileSync(rolloutPath, native + JSON.stringify({ type: "compacted", payload: { replacement_history: [] } }) + "\n");
      expect(() => store.resolve(request)).toThrow("native compaction");
      rmSync(rolloutPath);
      expect(() => store.resolve(request)).toThrow("no canonical rollout");
    },
  );
