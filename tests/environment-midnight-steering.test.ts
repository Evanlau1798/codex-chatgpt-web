import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { extractChatGptTurnEnvironment, extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { parseRequest } from "../src/responses/parser";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import type { CodexParsedRequest } from "../src/types";
import { root, currentWire, environmentXml, dangerFullAccessProfileXml } from "./environment-fixture";
const temporaryRoots: string[] = [];
afterEach(() => { for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const readOnlyProfileXml = `<permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry></file_system></permission_profile>`;
const externalProfileXml = `<permission_profile type="external"><file_system type="external" /></permission_profile>`;
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

  test("native workspace-write grants survive duplicate entries, external output roots and cache reload", () => {
    const fixture = resumedRootFixture();
    const output = resolve(root, "..", "native-authorized-output");
    const entries = [
      { path: { type: "special", value: { kind: "root" } }, access: "read" },
      { path: { type: "path", path: root }, access: "write" },
      { path: { type: "special", value: { kind: "slash_tmp" } }, access: "write" },
      { path: { type: "special", value: { kind: "tmpdir" } }, access: "write" },
      { path: { type: "path", path: output }, access: "write" },
      { path: { type: "path", path: output }, access: "write" },
      { path: { type: "path", path: join(root, ".git") }, access: "read", missing_path_behavior: "skip" },
    ];
    const context = childTurnContext(rolloutTurnId, {
      workspace_roots: [root],
      sandbox_policy: { type: "workspace-write", writable_roots: [output], network_access: false },
      permission_profile: { type: "managed", file_system: { type: "restricted", entries }, network: "restricted" },
      file_system_sandbox_policy: { kind: "restricted", entries },
    });
    const cache = join(fixture.codexHome, "thread-environments.json");
    for (const child of [false, true]) {
      const request = child ? environmentlessChild(rolloutTurnId, "workspace-write") : fixture.request;
      if (!child) {
        const body = request._rawBody as { client_metadata: Record<string, string> };
        const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]!);
        body.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ ...metadata, sandbox_mode: "workspace-write" });
      }
      writeFileSync(fixture.rolloutPath, [
        child ? childSessionMeta() : { type: "session_meta", payload: { id: rolloutThreadId, source: "vscode" } }, context,
      ].map(value => JSON.stringify(value)).join("\n") + "\n");
      for (let reload = 0; reload < 2; reload++) {
        const actual = new ChatGptThreadEnvironmentStore(cache, Date.now, fixture.codexHome).resolve(request);
        expect(actual.roots).toEqual([root]);
        expect(actual.writableRoots).toEqual([root, output]);
        expect(actual.sandboxPolicy).toEqual({ type: "workspaceWrite", writableRoots: [root, output], networkAccess: false });
      }
    }
    const saved = readFileSync(cache, "utf8");
    for (const field of ["writableRoots", "sandboxPolicy"] as const) {
      const state = JSON.parse(saved);
      const row = state.threads[rolloutThreadId];
      (field === "writableRoots" ? row.writableRoots : row.sandboxPolicy.writableRoots).push(resolve(root, "..", "unapproved"));
      const invalid = JSON.stringify(state);
      writeFileSync(cache, invalid);
      expect(() => new ChatGptThreadEnvironmentStore(cache, Date.now, fixture.codexHome).resolve(environmentlessChild(rolloutTurnId, "workspace-write")))
        .toThrow("contains invalid workspace or permission records");
      expect(readFileSync(cache, "utf8")).toBe(invalid);
    }
    entries.splice(4, 2);
    writeFileSync(fixture.rolloutPath, [childSessionMeta(), context].map(value => JSON.stringify(value)).join("\n") + "\n");
    expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, fixture.codexHome).resolve(environmentlessChild(rolloutTurnId, "workspace-write")))
      .toThrow("workspace-write permission profile is inconsistent");
  });

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

  test("a same-turn midnight delta obtains cwd and current permissions from its exact native rollout", () => {
    const { codexHome, request, body } = midnightRolloutFixture();
    request.context.tools = [{ name: "current_only", description: "d", parameters: { type: "object" } }];
    expect(() => extractChatGptTurnEnvironment(request)).toThrow("missing cwd");
    // Both an empty store and an older cached directory must resolve from the current native turn.
    for (const cached of [false, true]) {
      const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
      if (cached) store.resolve(currentWire({ threadId: rolloutThreadId,
        workspace: resolve(root, "old-workspace"), environmentXml: environmentXml.replaceAll(root, resolve(root, "old-workspace")) }));
      expect(store.resolve(request)).toEqual({
        cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" }, tools: request.context.tools,
      });
    }
    // A full start envelope does not make a later delta disappear at extraction time.
    body.input.unshift({ type: "message", role: "user", id: "msg_start_environment",
      internal_chat_message_metadata_passthrough: { turn_id: rolloutTurnId },
      content: [{ type: "input_text", text: environmentXml }] });
    expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request).cwd).toBe(root);
  });

  test("midnight recovery never borrows cached authority without exact current rollout proof", () => {
    const { codexHome, request, rolloutPath, delta } = midnightRolloutFixture();
    const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
    store.resolve(currentWire({ threadId: rolloutThreadId }));
    const native = readFileSync(rolloutPath, "utf8");
    rmSync(rolloutPath);
    expect(() => store.resolve(request)).toThrow("no canonical rollout");
    const calendarText = delta.content[0]!.text;
    delta.content[0]!.text = "<environment_context><cwd";
    expect(() => store.resolve(request)).toThrow("no canonical rollout");
    delta.content[0]!.text = calendarText;
    writeFileSync(rolloutPath, native.replaceAll(rolloutTurnId, rolloutParentId));
    expect(() => store.resolve(request)).toThrow();
    writeFileSync(rolloutPath, native.replaceAll(rolloutThreadId, rolloutParentId));
    expect(() => store.resolve(request)).toThrow();
  });

  test("midnight recovery rejects conflicting current policy and malformed deltas even with a valid start envelope", () => {
    const { codexHome, request, body, delta } = midnightRolloutFixture();
    const original = delta.content[0]!.text;
    const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
    store.resolve(currentWire({ threadId: rolloutThreadId }));
    const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]!);
    for (const contradictory of [
      { ...metadata, sandbox_mode: "read-only" },
      { ...metadata, sandbox: "read-only" },
    ]) {
      body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(contradictory);
      expect(() => store.resolve(request)).toThrow();
    }
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
    for (const withStartEnvelope of [false, true]) {
      if (withStartEnvelope) body.input.unshift({ type: "message", role: "user", id: "msg_start_environment",
        internal_chat_message_metadata_passthrough: { turn_id: rolloutTurnId },
        content: [{ type: "input_text", text: environmentXml }] });
      for (const invalid of [
        original.replace(dangerFullAccessProfileXml, dangerFullAccessProfileXml + externalProfileXml),
        original.replace(dangerFullAccessProfileXml, externalProfileXml),
        original.replace(dangerFullAccessProfileXml, readOnlyProfileXml),
        original.replace(dangerFullAccessProfileXml, ""),
        original.replace("<current_date>", "<cwd/><current_date>"),
        "<environment_context><cwd",
        "</environment_context>",
      ]) {
        delta.content[0]!.text = invalid;
        expect(() => store.resolve(request)).toThrow();
      }
      delta.content[0]!.text = original;
    }
    Object.assign(delta.internal_chat_message_metadata_passthrough, {
      content_item_kinds: ["environments.environment_context"],
    });
    delta.content[0]!.text = "<environment_context><cwd";
    expect(() => store.resolve(request)).toThrow();
  });

  test("environment XML examples in assistant, tool, and user text do not invalidate current authority", () => {
    const example = "<environment_context><cwd/></environment_context>";
    const request = currentWire();
    const body = request._rawBody as { input: Array<Record<string, unknown>> };
    for (const item of body.input) item.internal_chat_message_metadata_passthrough = { turn_id: "turn_current" };
    body.input.push({ type: "function_call", id: "fc_example", call_id: "call_example", name: "fixture", arguments: "{}" });
    for (const turn_id of [undefined, "turn_current"]) for (const text of [example, `Example:\n\`\`\`xml\n${example}\n\`\`\``]) {
      const input = [...body.input,
        { type: "function_call_output", call_id: "call_example", output: example },
        { type: "message", role: "assistant", id: "msg_xml_example",
          ...(turn_id ? { internal_chat_message_metadata_passthrough: { turn_id } } : {}),
          content: [{ type: "output_text", text }] },
      ];
      const parsed = { ...request, _rawBody: { ...body, input } };
      expect(extractChatGptTurnEnvironment(parsed).cwd).toBe(root);
      expect(new ChatGptThreadEnvironmentStore().resolve(parsed).sandboxPolicy.type).toBe("dangerFullAccess");
      const instruction = { type: "message", role: "user", id: "msg_explain_xml",
        internal_chat_message_metadata_passthrough: { turn_id: "turn_current" },
        content: [{ type: "input_text", text: `Explain this XML without changing permissions: ${example}` }] };
      input.push(instruction);
      expect(extractChatGptTurnUserRevision(parsed)).toEqual(instruction.content);
      expect(new ChatGptThreadEnvironmentStore().resolve(parsed).cwd).toBe(root);
      // On follow-up rounds the existing thread store also ignores quoted XML in history.
      const store = new ChatGptThreadEnvironmentStore();
      store.resolve(request);
      expect(store.resolve({ ...parsed, _rawBody: { ...body, input: input.slice(2) } }).cwd).toBe(root);
    }
  });

  function steeredRolloutFixture(child: boolean, workspaceRoots: string[]) {
    const fixture = resumedRootFixture();
    const { request, rolloutPath } = fixture;
    const auxiliary = resolve(root, "..", "native-auxiliary-workspace");
    const xml = environmentXml.replace(`<root>${root}</root>`, `<root>${root}</root><root>${auxiliary}</root>`);
    const body = request._rawBody as { input: Array<Record<string, unknown>>; client_metadata: Record<string, string> };
    const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]!);
    metadata.workspaces = Object.fromEntries(workspaceRoots.map(path => [path, {}]));
    if (child) Object.assign(metadata, {
      parent_thread_id: rolloutParentId, agent_name: rolloutAgent, subagent_kind: "thread_spawn",
    });
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
    const original = structuredClone(body.input[0]!);
    original.id = "msg_original_instruction";
    body.input[0]!.content = [{ type: "input_text", text: "Finish the bounded investigation now." }];
    const environment = {
      type: "message", role: "user", id: "msg_native_preamble",
      internal_chat_message_metadata_passthrough: { turn_id: rolloutTurnId },
      content: [
        { type: "input_text", text: "<recommended_plugins>example</recommended_plugins>" },
        { type: "input_text", text: xml },
      ],
    };
    body.input.unshift(environment, original, {
      type: "message", role: "assistant", id: "msg_finished", phase: "final_answer",
      content: [{ type: "output_text", text: "The first instruction is complete." }],
      internal_chat_message_metadata_passthrough: { turn_id: rolloutTurnId },
    });
    const session = child ? childSessionMeta()
      : { type: "session_meta", payload: { id: rolloutThreadId, source: "vscode" } };
    writeFileSync(rolloutPath, [session, childTurnContext(rolloutTurnId, { workspace_roots: [root, auxiliary] })]
      .map(value => JSON.stringify(value)).join("\n") + "\n");
    return { ...fixture, request: parseRequest({ ...body, model: "chatgpt-web/pro" }), body, environment, auxiliary };
  }

  test("same-turn steering resolves V1 children without an assigned agent path", () => {
    const { codexHome, request, body, rolloutPath, auxiliary } = steeredRolloutFixture(true, []);
    const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]!);
    metadata.agent_name = "/root";
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
    const native = readFileSync(rolloutPath, "utf8").replaceAll(JSON.stringify(rolloutAgent), "null");
    writeFileSync(rolloutPath, native);
    expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request).roots)
      .toEqual([root, auxiliary]);
  });

  for (const child of [false, true]) for (const gitRoots of [[], [root]]) {
    test(`same-turn steering authenticates ${child ? "child" : "root"} auxiliary roots against the current rollout with ${gitRoots.length} Git roots`, () => {
      const { codexHome, request, body, auxiliary } = steeredRolloutFixture(child, gitRoots);
      const beforeSteering = { ...request, _rawBody: { ...body, input: body.input.slice(0, -1) } };
      expect(extractChatGptTurnEnvironment(beforeSteering).roots).toEqual([root, auxiliary]);
      expect(() => extractChatGptTurnEnvironment(request)).toThrow("missing cwd");
      request.context.tools = [{ name: "current_only", description: "d", parameters: { type: "object" } }];
      expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request)).toEqual({
        cwd: root, roots: [root, auxiliary], writableRoots: [root, auxiliary],
        sandboxPolicy: { type: "dangerFullAccess" }, tools: request.context.tools,
      });
    });
  }

  test("steering never replaces missing or contradictory rollout proof with cached authority", () => {
    const { codexHome, request, body, rolloutPath, environment, auxiliary } = steeredRolloutFixture(false, []);
    const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
    store.resolve({ ...request, _rawBody: { ...body, input: body.input.slice(0, -1) } });
    const native = readFileSync(rolloutPath, "utf8");
    rmSync(rolloutPath);
    expect(() => store.resolve(request)).toThrow("no canonical rollout");
    writeFileSync(rolloutPath, native);
    const original = environment.content[1]!.text;
    for (const claim of [
      original.replaceAll(auxiliary, resolve(root, "..", "unproven-root")),
      original.replace(dangerFullAccessProfileXml, "<sandbox_mode>read-only</sandbox_mode>"),
      original.replace(`<cwd>${root}</cwd>`, "<cwd/>"),
    ]) {
      environment.content[1]!.text = claim;
      expect(() => store.resolve(request)).toThrow();
    }
    environment.content[1]!.text = original;
    writeFileSync(rolloutPath, native.replaceAll(rolloutTurnId, rolloutParentId));
    expect(() => store.resolve(request)).toThrow("current turn");
  });

  test("steering proof requires one attributed envelope and two current native instructions", () => {
    const { codexHome, request, body, environment } = steeredRolloutFixture(false, []);
    const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
    for (const index of [1, 3]) {
      const item = body.input[index]!;
      const metadata = item.internal_chat_message_metadata_passthrough;
      item.internal_chat_message_metadata_passthrough = { turn_id: rolloutParentId };
      expect(() => store.resolve(request)).toThrow();
      item.internal_chat_message_metadata_passthrough = metadata;
    }
    body.input.push({ ...environment, id: "msg_new_invalid_update", content: [
      { type: "input_text", text: "<environment_context><cwd/></environment_context>" },
    ] });
    expect(() => store.resolve(request)).toThrow();
    body.input.pop();
    body.input[0] = { ...environment, id: undefined };
    expect(() => store.resolve(request)).toThrow();
  });

const workspaceWriteProfileXml = `<permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry><entry access="write"><path>${root}</path></entry><entry access="write"><special>:slash_tmp</special></entry><entry access="write"><special>:tmpdir</special></entry><entry access="read"><path>${root}/.git</path></entry></file_system></permission_profile>`;
  test("steering accepts a native output write root beyond the workspace roots", () => {
    const { codexHome, request, body, rolloutPath, environment, auxiliary } = steeredRolloutFixture(false, []);
    const output = join(codexHome, "visualizations", "current-task");
    environment.content[1]!.text = environment.content[1]!.text.replace(
      dangerFullAccessProfileXml, workspaceWriteProfileXml,
    );
    const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]!);
    metadata.sandbox_mode = "workspace-write";
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
    const entries = [
      { path: { type: "special", value: { kind: "root" } }, access: "read" },
      ...[root, auxiliary, output].map(path => ({ path: { type: "path", path }, access: "write" })),
      { path: { type: "special", value: { kind: "slash_tmp" } }, access: "write" },
      { path: { type: "special", value: { kind: "tmpdir" } }, access: "write" },
    ];
    writeFileSync(rolloutPath, [
      { type: "session_meta", payload: { id: rolloutThreadId, source: "vscode" } },
      childTurnContext(rolloutTurnId, {
        workspace_roots: [root, auxiliary],
        sandbox_policy: { type: "workspace-write", writable_roots: [auxiliary, output], network_access: false },
        permission_profile: { type: "managed", file_system: { type: "restricted", entries }, network: "restricted" },
        file_system_sandbox_policy: { kind: "restricted", entries },
      }),
    ].map(value => JSON.stringify(value)).join("\n") + "\n");

    const actual = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request);
    expect(actual.roots).toEqual([root, auxiliary]);
    expect(actual.writableRoots).toEqual([root, auxiliary, output]);
    expect(actual.sandboxPolicy).toEqual({
      type: "workspaceWrite", writableRoots: [root, auxiliary, output], networkAccess: false,
    });

    const originalClaim = environment.content[1]!.text;
    environment.content[1]!.text = originalClaim.replace(
      "</file_system>", `<entry access="write"><path>${join(codexHome, "unproven-output")}</path></entry></file_system>`,
    );
    // Envelope entries cannot add grants: only the current native rollout can.
    expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request)).toEqual(actual);
    environment.content[1]!.text = originalClaim;

    environment.content[1]!.text = environment.content[1]!.text.replace(
      `<root>${auxiliary}</root>`, `<root>${resolve(root, "..", "unproven-root")}</root>`,
    );
    expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request))
      .toThrow("Steering environment conflicts");
  });

for (const mode of ["workspace-write", "read-only"] as const) test(`${mode} uses one native network policy before and after steering`, async () => {
    const { codexHome, request, body, rolloutPath, environment, auxiliary } = steeredRolloutFixture(false, []);
    environment.content[1]!.text = environment.content[1]!.text.replace(
      dangerFullAccessProfileXml, mode === "workspace-write" ? workspaceWriteProfileXml : readOnlyProfileXml,
    );
    const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]!);
    metadata.sandbox_mode = mode;
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
    const entries = [
      { path: { type: "special", value: { kind: "root" } }, access: "read" },
      ...(mode === "workspace-write" ? [
        ...[root, auxiliary].map(path => ({ path: { type: "path", path }, access: "write" })),
        { path: { type: "special", value: { kind: "slash_tmp" } }, access: "write" },
        { path: { type: "special", value: { kind: "tmpdir" } }, access: "write" },
      ] : []),
    ];
    const writeRollout = (networkAccess: boolean) => writeFileSync(rolloutPath, [
      { type: "session_meta", payload: { id: rolloutThreadId, source: "vscode" } },
      childTurnContext(rolloutTurnId, {
        workspace_roots: [root, auxiliary],
        sandbox_policy: { type: mode, ...(mode === "workspace-write" ? { writable_roots: [auxiliary] } : {}), network_access: networkAccess },
        permission_profile: {
          type: "managed", file_system: { type: "restricted", entries }, network: networkAccess ? "enabled" : "restricted",
        },
        file_system_sandbox_policy: { kind: "restricted", entries },
      }),
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
    const statePath = join(codexHome, "environment-cache.json");
    const store = new ChatGptThreadEnvironmentStore(statePath, Date.now, codexHome);
    const resolved = () => store.resolve(request);
    const beforeSteering = { ...request, _rawBody: { ...body, input: body.input.slice(0, -1) } };
    const withoutEnvelope = { ...request, _rawBody: { ...body, input: body.input.slice(-1) } };
    const cachedFollowup = { ...request, _rawBody: {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: rolloutThreadId, turn_id: rolloutTurnId }) },
      input: body.input.slice(-1),
    } };
    const broker = TurnBroker.forSocket(process.platform === "win32"
      ? defaultBrokerEndpoint(codexHome)
      : join(codexHome, "review.sock"));
    try {
      for (const enabled of [true, false]) {
        writeRollout(enabled);
        const initial = store.resolve(beforeSteering);
        expect(initial.sandboxPolicy).toEqual(mode === "workspace-write"
          ? { type: "workspaceWrite", writableRoots: [root, auxiliary], networkAccess: enabled }
          : { type: "readOnly", networkAccess: enabled });
        const token = await broker.register(initial, 10_000);
        for (const input of [request, withoutEnvelope, beforeSteering]) {
          const next = store.resolve(input);
          expect(next.sandboxPolicy).toEqual(initial.sandboxPolicy);
          expect(() => broker.updateEnvironment(token, next)).not.toThrow();
        }
        expect(new ChatGptThreadEnvironmentStore(statePath, Date.now, codexHome).resolve(cachedFollowup).sandboxPolicy)
          .toEqual(initial.sandboxPolicy);
        writeRollout(!enabled);
        expect(() => broker.updateEnvironment(token, store.resolve(withoutEnvelope)))
          .toThrow("environment changed");
        broker.revoke(token);
      }
    } finally { await broker.close(); }

    // An envelope that does state its network policy is still held to the rollout.
    writeRollout(true);
    const unstated = environment.content[1]!.text;
    environment.content[1]!.text = unstated.replace("<filesystem>", "<network_access>restricted</network_access><filesystem>");
    expect(resolved).toThrow("Steering environment conflicts");
    environment.content[1]!.text = unstated.replace("<filesystem>", "<network_access>enabled</network_access><filesystem>");
    expect(resolved().sandboxPolicy).toMatchObject({ networkAccess: true });
    writeRollout(false);
    expect(resolved).toThrow("Steering environment conflicts");
    environment.content[1]!.text = unstated;
    expect(resolved().sandboxPolicy).toMatchObject({ networkAccess: false });
    // Unstated permissions require current evidence, even when a cache already exists.
    rmSync(rolloutPath);
    expect(() => store.resolve(beforeSteering)).toThrow("no canonical rollout");
    expect(resolved).toThrow("no canonical rollout");
  });
