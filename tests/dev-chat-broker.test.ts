import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { parseRequest } from "../src/responses/parser";
import {
  callTurnBroker,
  RemoteTurnBroker,
  TurnBroker,
  type BrokerToolResult,
} from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";

test("remote owners preserve Full Access worktree cwd outside project roots", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-dev-worktree-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const remote = new RemoteTurnBroker(socketPath);
  await broker.listen();
  const environment = {
    cwd: join(root, "worktree"), roots: [join(root, "project")],
    writableRoots: [join(root, "project")],
    sandboxPolicy: { type: "dangerFullAccess" as const }, tools: [],
  };
  try {
    const token = await remote.register(environment, 60_000, "worktree-owner");
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const resolved = await callTurnBroker(socketPath, { method: "resolve", bindingId: claimed.bindingId });
    expect(resolved).toMatchObject({ environment });
    await remote.revoke(token);
    for (const sandboxPolicy of [
      { type: "readOnly" as const, networkAccess: false },
      { type: "workspaceWrite" as const, writableRoots: environment.roots, networkAccess: false },
    ]) {
      await expect(remote.register({ ...environment, sandboxPolicy }, 60_000, "restricted-worktree"))
        .rejects.toThrow("environment is invalid");
    }
    expect(broker.externalOwnerActiveCount()).toBe(0);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("external worktree owners retain canonical native Full Access proof", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-dev-native-worktree-"));
  const codexHome = join(root, "codex");
  const threadId = "01a06c66-4232-7ae1-9108-69b5f70e0671";
  const turnId = "01a06c66-4380-75c6-a0df-318f890ef6de";
  const cwd = join(root, "worktree");
  const project = join(root, "project");
  const rolloutPath = join(codexHome, "sessions", "2026", "10", "29", `rollout-2026-10-29T00-00-00-${threadId}.jsonl`);
  const context = { turn_id: turnId, cwd, sandbox_policy: { type: "danger-full-access" },
    permission_profile: { type: "disabled" } };
  const writeContext = (payload: Record<string, unknown>) => writeFileSync(rolloutPath, [
    { type: "session_meta", payload: { id: threadId, source: "vscode", runtime_workspace_roots: [project] } },
    { type: "turn_context", payload },
  ].map(item => JSON.stringify(item)).join("\n") + "\n");
  const request = parseRequest({ model: "chatgpt-web/high", client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: threadId, turn_id: turnId,
      agent_name: "/root", sandbox_mode: "danger-full-access", workspaces: { [cwd]: {} } }),
  }, input: [{ type: "message", role: "user", id: "msg_native_worktree_instruction",
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
    content: [{ type: "input_text", text: "Inspect the current worktree." }] }] });
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const remote = new RemoteTurnBroker(socketPath);
  const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
  await broker.listen();
  try {
    mkdirSync(dirname(rolloutPath), { recursive: true });
    writeContext(context);
    const environment = store.resolve(request);
    expect(environment).toEqual({ cwd, roots: [project], writableRoots: [project],
      sandboxPolicy: { type: "dangerFullAccess" }, tools: [] });
    const token = await remote.register(environment, 60_000, "native-worktree-owner");
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    expect(await callTurnBroker(socketPath, { method: "resolve", bindingId: claimed.bindingId }))
      .toMatchObject({ environment });
    await remote.revoke(token);
    const registerCurrent = async () => remote.register(store.resolve(request), 60_000, "native-worktree-owner");
    for (const invalid of [
      { ...context, permission_profile: { type: "managed" } },
      { ...context, permission_profile: undefined },
      { ...context, sandbox_policy: { type: "read-only", network_access: false } },
      { ...context, sandbox_policy: undefined },
      { ...context, file_system_sandbox_policy: { kind: "restricted", entries: [] } },
      { ...context, turn_id: "01a06c66-ffff-75c6-a0df-318f890ef6de" },
    ]) {
      writeContext(invalid);
      await expect(registerCurrent()).rejects.toThrow();
      expect(broker.externalOwnerActiveCount()).toBe(0);
    }
    rmSync(rolloutPath);
    await expect(registerCurrent()).rejects.toThrow("no canonical rollout");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("all external owner methods preserve restricted cwd containment and environment validation", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-dev-owner-validation-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const remote = new RemoteTurnBroker(socketPath);
  const environment = { cwd: join(root, "worktree"), roots: [join(root, "project")],
    writableRoots: [join(root, "project")], sandboxPolicy: { type: "dangerFullAccess" as const }, tools: [] };
  const nonce = "external_worktree_surface_000001";
  await broker.listen();
  try {
    const token = await remote.register(environment, 60_000, "validation-worktree");
    await remote.updateEnvironment(token, environment);
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const safeToken = await remote.registerSafe(environment, nonce, 60_000, "validation-safe-worktree");
    expect(safeToken).toStartWith("request_");
    await remote.revoke(safeToken);
    const readOnly = { type: "readOnly" as const, networkAccess: false };
    const workspaceWrite = { type: "workspaceWrite" as const, writableRoots: environment.roots, networkAccess: false };
    for (const invalid of [
      { ...environment, sandboxPolicy: readOnly },
      { ...environment, sandboxPolicy: workspaceWrite },
      { ...environment, sandboxPolicy: readOnly, sandbox_mode: "danger-full-access",
        permission_profile: { type: "disabled" }, sandbox_policy: { type: "danger-full-access" } },
      { ...environment, sandboxPolicy: undefined },
      { ...environment, sandboxPolicy: { type: "unknown" } },
      { ...environment, cwd: "relative" },
      { ...environment, roots: [] },
      { ...environment, roots: ["relative"] },
      { ...environment, writableRoots: ["relative"] },
      { ...environment, tools: [{ name: "exec_command", description: "Invalid parameters", parameters: [] }] },
    ]) {
      await expect(remote.register(invalid as never, 60_000, "invalid-worktree")).rejects.toThrow("environment is invalid");
      await expect(remote.registerSafe(invalid as never, nonce, 60_000, "invalid-safe-worktree")).rejects.toThrow("environment is invalid");
      await expect(remote.updateEnvironment(token, invalid as never)).rejects.toThrow("environment is invalid");
      expect(await callTurnBroker(socketPath, { method: "resolve", bindingId: claimed.bindingId }))
        .toMatchObject({ environment });
    }
    await remote.revoke(token);
    for (const sandboxPolicy of [readOnly, workspaceWrite]) {
      const restricted = { ...environment, cwd: environment.roots[0]!, sandboxPolicy };
      const restrictedToken = await remote.register(restricted, 60_000, "valid-restricted-owner");
      const binding = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token: restrictedToken });
      expect(await callTurnBroker(socketPath, { method: "resolve", bindingId: binding.bindingId }))
        .toMatchObject({ environment: restricted });
      await remote.revoke(restrictedToken);
    }
    expect(broker.externalOwnerActiveCount()).toBe(0);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote outer harness owns a turn through the live broker protocol", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-dev-owner-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const remote = new RemoteTurnBroker(socketPath);
  await broker.listen();
  try {
    await remote.assertCompatible();
    await expect(remote.register({ cwd: "relative", roots: [], tools: [] } as never, 60_000, "invalid-owner"))
      .rejects.toThrow("environment is invalid");
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [{ name: "exec_command", description: "Simulated command", parameters: { type: "object" } }],
    };
    const token = await remote.register(environment, 60_000, "dev-owner-test");
    const retirement = remote.waitForRetirement(token);
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const invocation = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      arguments: { cmd: "pwd" },
    }, 10_000);
    const batch = await remote.nextToolBatch(token);
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ wireName: "exec_command", arguments: { cmd: "pwd" } });
    await remote.completeTool(token, batch[0]!.callId, {
      content: [{ type: "text", text: "simulated" }],
      structuredContent: { simulated: true },
    });
    expect(await invocation).toMatchObject({ structuredContent: { simulated: true } });
    await remote.revoke(token);
    await expect(retirement).resolves.toBeUndefined();
    await expect(callTurnBroker(socketPath, { method: "claim", token })).rejects.toThrow("already finished");
    expect(broker.externalOwnerActiveCount()).toBe(0);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("disconnecting a remote owner_next removes its broker waiter", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-dev-owner-waiter-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const remote = new RemoteTurnBroker(socketPath);
  await broker.listen();
  const environment = {
    cwd: root,
    roots: [root],
    writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" as const },
    tools: [{ name: "exec_command", description: "Command", parameters: { type: "object" } }],
  };
  const token = await remote.register(environment, 60_000, "remote-waiter-test");
  try {
    const abandoned = new AbortController();
    const firstWait = remote.nextToolBatch(token, abandoned.signal);
    await Bun.sleep(20);
    abandoned.abort();
    await expect(firstWait).rejects.toMatchObject({ name: "AbortError" });

    const secondWait = remote.nextToolBatch(token);
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, {
      method: "claim",
      token,
      activityId: "activity_remote_waiter_000001",
    });
    const invocation = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      arguments: { cmd: "pwd" },
    }, 10_000);
    const [request] = await secondWait;
    await remote.completeTool(token, request!.callId, { content: [{ type: "text", text: "ok" }] });
    await invocation;
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
