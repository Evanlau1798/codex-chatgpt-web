import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { callTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";

test("Native2 wait releases the serial MCP channel before the child finishes", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-wait-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const environment = {
    cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" as const },
    tools: [{ namespace: "multi_agent_v2", name: "wait_agent", description: "Wait", parameters: {} },
      { name: "exec_command", description: "Read a file", parameters: {} }],
  };
  const parent = await broker.register(environment, 60_000, "wait-parent", undefined, true);
  const child = await broker.register(environment, 60_000, "wait-child", undefined, true);
  const contextToken = await broker.registerContext("Child context\n", 60_000, "wait-child", child);
  let client = new Client({ name: "async-wait-test", version: "1.0.0" });
  const transport = () => new StdioClientTransport({ command: process.execPath,
    args: [resolve(import.meta.dir, "../src/cli.ts"), "mcp", "--broker-socket", socketPath], stderr: "pipe" });
  let serial = Promise.resolve();
  const call = (name: string, args: Record<string, unknown>) => {
    const next = serial.then(() => client.callTool({ name, arguments: args }));
    serial = next.then(() => {}, () => {});
    return next;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await client.connect(transport());
    const waiting = call("codex_tool_call", { turn_token: parent, wire_name: "multi_agent_v2__wait_agent",
      arguments: { targets: ["same-child"], timeout_ms: 60_000 } });
    const [request] = await broker.nextToolBatch(parent, AbortSignal.timeout(5_000));
    expect(request!.arguments).toEqual({ targets: ["same-child"], timeout_ms: 30_000 });
    // No native result is released until both receipt and child output have passed this serial channel.
    const receipt = await Promise.race([waiting.then(value => value.structuredContent),
      new Promise(resolve => { timer = setTimeout(() => resolve({ operation_status: "blocked" }), 1_000); })]);
    expect(receipt).toMatchObject({ operation_status: "pending", wait_id: expect.any(String) });
    const pending = receipt as { wait_id: string; next_query: string };
    expect(broker.beginCompletionFence(parent)).toBeUndefined();
    const archive = await call("codex_tool_inventory", { turn_token: contextToken, query: "__codex_context__:0" });
    expect(JSON.stringify(archive.content)).toContain("CODEX_CONTEXT_ARCHIVE_READY");
    const output = await call("codex_tool_call", { turn_token: child, wire_name: "codex.control.output",
      arguments: { kind: "commentary", text: "Child can make progress while its parent waits." } });
    expect(output.isError).not.toBeTrue();
    expect((await broker.nextOutput(child, 0)).kind).toBe("commentary");
    const childWork = call("codex_tool_call", { turn_token: child, wire_name: "exec_command", arguments: { cmd: "read-only probe" } });
    const [childRequest] = await broker.nextToolBatch(child, AbortSignal.timeout(2_000));
    broker.completeTool(child, childRequest!.callId, { content: [{ type: "text", text: "file evidence" }] });
    expect(JSON.stringify((await childWork).content)).toContain("file evidence");
    expect(broker.beginCompletionFence(parent)).toBeUndefined();
    const result: BrokerToolResult = { content: [{ type: "text", text: "native timeout" }],
      structuredContent: { timed_out: true, status: {} } };
    broker.completeTool(parent, request!.callId, result);
    expect(broker.beginCompletionFence(parent)).toBeUndefined();
    const [retryRequest] = await broker.nextToolBatch(parent, AbortSignal.timeout(5_000));
    expect(retryRequest!.arguments).toEqual(request!.arguments);
    const stillPending = await call("codex_tool_inventory", { turn_token: parent, query: pending.next_query });
    expect(stillPending.structuredContent).toEqual({
      operation_status: "pending", wait_id: pending.wait_id, next_query: pending.next_query,
    });
    const terminal = { content: [{ type: "text", text: "same child completed" }],
      structuredContent: { timed_out: false, status: { "same-child": { completed: "Final evidence" } } } };
    broker.completeTool(parent, retryRequest!.callId, terminal);
    await client.close();
    client = new Client({ name: "async-wait-reconnected", version: "1.0.0" });
    await client.connect(transport());
    const read = () => call("codex_tool_inventory", { turn_token: parent, query: pending.next_query });
    expect((await read()).structuredContent).toEqual({ operation_status: "ready", wait_id: pending.wait_id, result: terminal });
    expect((await read()).structuredContent).toEqual({ operation_status: "ready", wait_id: pending.wait_id, result: terminal });
    expect(broker.beginCompletionFence(parent)).toBeNumber();
    const nextWait = call("codex_tool_call", { turn_token: parent, wire_name: "multi_agent_v2__wait_agent",
      arguments: { targets: ["same-child"], timeout_ms: 30_000 } });
    const [nextRequest] = await broker.nextToolBatch(parent, AbortSignal.timeout(5_000));
    expect(nextRequest!.arguments).toEqual(request!.arguments);
    const nextReceipt = (await nextWait).structuredContent as { wait_id: string; next_query: string };
    expect(nextReceipt.wait_id).not.toBe(pending.wait_id);
    broker.completeTool(parent, nextRequest!.callId, terminal);
    expect((await call("codex_tool_inventory", { turn_token: parent, query: nextReceipt.next_query })).structuredContent)
      .toMatchObject({ operation_status: "ready", result: terminal });
  } finally {
    if (timer) clearTimeout(timer);
    broker.revoke(parent); broker.revoke(child);
    await client.close().catch(() => {});
    await serial;
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test.each(["multi_agent_v1", "multi_agent_v2", "collaboration"].flatMap(namespace =>
  [false, true].map(gateway => [namespace, gateway] as const),
))("agent wait ownership, deduplication and native results survive %s (gateway=%s)", async (namespace, gateway) => {
  const root = mkdtempSync(join(tmpdir(), "cgw-wait-routes-"));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  const tokens: string[] = [];
  try {
    const token = await broker.register({ cwd: root, roots: [root], writableRoots: [],
      sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: gateway
        ? [{ name: "exec", freeform: true, description: "Native gateway", parameters: {} }]
        : [{ namespace, name: "wait_agent", description: "Native wait", parameters: {} }],
    }, 60_000, "routes", undefined, true);
    tokens.push(token);
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(socket, {
      method: "claim", token, activityId: "activity_1234567890123456",
    });
    await callTurnBroker(socket, { method: "activity_complete", token, activityId: "activity_1234567890123456" });
    const wireName = `${namespace}__wait_agent`;
    const args = { targets: ["child"], timeout_ms: 180_000 };
    const start = (arguments_ = args) => callTurnBroker<{ wait_id: string }>(socket, {
      method: "start_agent_wait", bindingId, wireName, arguments: arguments_,
    });
    const receipt = await start();
    expect(await start()).toEqual(receipt);
    await expect(start({ ...args, targets: ["other"] })).rejects.toThrow("existing agent wait");
    await expect(start({ ...args, timeout_ms: 30_001 })).rejects.toThrow("timeout_ms");
    await expect(callTurnBroker(socket, { method: "read_agent_wait", token: "turn_wrong", waitId: receipt.wait_id }))
      .rejects.toThrow("invalid");
    expect(broker.beginCompletionFence(token)).toBeUndefined();
    const requests = await broker.nextToolBatch(token, AbortSignal.timeout(2_000));
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    if (gateway) {
      expect(request.wireName).toBe("exec");
      const calls: unknown[] = [];
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      await new AsyncFunction("tools", "ALL_TOOLS", "text", request.input)(
        { [wireName]: async (input: unknown) => { calls.push(input); return { native: true }; } },
        [{ name: wireName }], () => {},
      );
      expect(calls).toEqual([{ ...args, timeout_ms: 30_000 }]);
    } else expect(request.arguments).toEqual({ ...args, timeout_ms: 30_000 });
    const result = { content: [{ type: "text", text: "native error" }], isError: true,
      structuredContent: { untouched: "metadata" }, _meta: { evidence: 42 } };
    broker.completeTool(token, request.callId, result);
    await expect(callTurnBroker(socket, { method: "submit_output", token, outputKind: "final", outputText: "Premature" }))
      .rejects.toThrow();
    const ready = await callTurnBroker(socket, { method: "read_agent_wait", token, waitId: receipt.wait_id });
    expect(ready).toEqual({ operation_status: "ready", wait_id: receipt.wait_id, result });
    expect(broker.beginCompletionFence(token)).toBeNumber();
    broker.revoke(token);
    await expect(callTurnBroker(socket, { method: "read_agent_wait", token, waitId: receipt.wait_id })).rejects.toThrow("revoked");
  } finally {
    tokens.forEach(token => broker.revoke(token));
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("one-hour logical agent wait uses 120 bounded slices and rejects a longer timeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-wait-hour-"));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  const token = await broker.register({ cwd: root, roots: [root], writableRoots: [],
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    tools: [{ namespace: "multi_agent_v2", name: "wait_agent", description: "Wait", parameters: {} }],
  }, 60_000, "one-hour-wait", undefined, true);
  try {
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(socket, {
      method: "claim", token, activityId: "activity_1234567890123456",
    });
    await callTurnBroker(socket, { method: "activity_complete", token, activityId: "activity_1234567890123456" });
    const receipt = await callTurnBroker<{ wait_id: string }>(socket, { method: "start_agent_wait", bindingId,
      wireName: "multi_agent_v2__wait_agent", arguments: { targets: ["child"], timeout_ms: 3_600_000 } });
    const timedOut: BrokerToolResult = { content: [{ type: "text", text: "pending" }],
      structuredContent: { timed_out: true, status: {} } };
    for (let slice = 1; slice < 120; slice++) {
      const [request] = await broker.nextToolBatch(token, AbortSignal.timeout(2_000));
      expect(request!.arguments).toEqual({ targets: ["child"], timeout_ms: 30_000 });
      broker.completeTool(token, request!.callId, timedOut);
    }
    const [finalRequest] = await broker.nextToolBatch(token, AbortSignal.timeout(2_000));
    const terminal: BrokerToolResult = { content: [{ type: "text", text: "complete" }],
      structuredContent: { timed_out: false, status: { child: { completed: "done" } } } };
    broker.completeTool(token, finalRequest!.callId, terminal);
    await Promise.resolve();
    expect(await callTurnBroker<unknown>(socket, { method: "read_agent_wait", token, waitId: receipt.wait_id }))
      .toEqual({ operation_status: "ready", wait_id: receipt.wait_id, result: terminal });
    await expect(callTurnBroker(socket, { method: "start_agent_wait", bindingId,
      wireName: "multi_agent_v2__wait_agent", arguments: { targets: ["child"], timeout_ms: 3_630_000 } }))
      .rejects.toThrow("timeout_ms");
  } finally {
    broker.revoke(token);
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("compaction supersedes a queued agent wait and expiration retires pending ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-wait-retire-"));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  const tokens: string[] = [];
  const start = async (ttlMs: number) => {
    const token = await broker.register({ cwd: root, roots: [root], writableRoots: [],
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      tools: [{ namespace: "multi_agent_v2", name: "wait_agent", parameters: {}, description: "Wait" }],
    }, ttlMs);
    tokens.push(token);
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(socket, {
      method: "claim", token, activityId: "activity_1234567890123456",
    });
    await callTurnBroker(socket, { method: "activity_complete", token, activityId: "activity_1234567890123456" });
    const receipt = await callTurnBroker<{ wait_id: string }>(socket, { method: "start_agent_wait", bindingId,
      wireName: "multi_agent_v2__wait_agent", arguments: { targets: ["child"], timeout_ms: 30_000 } });
    return { token, receipt };
  };
  try {
    const { token, receipt } = await start(60_000);
    const control = { content: [{ type: "text", text: "Compaction handoff required" }] };
    expect(broker.requestCompaction(token, control)).toBe(1);
    expect(await callTurnBroker<unknown>(socket, { method: "read_agent_wait", token, waitId: receipt.wait_id }))
      .toEqual({ operation_status: "ready", wait_id: receipt.wait_id, result: control });
    expect(broker.beginCompletionFence(token)).toBeNumber();
    broker.revoke(token);
    const expiring = await start(250);
    await broker.waitForRetirement(expiring.token, AbortSignal.timeout(2_000));
    await expect(callTurnBroker(socket, { method: "read_agent_wait", token: expiring.token, waitId: expiring.receipt.wait_id }))
      .rejects.toThrow("revoked");
  } finally {
    tokens.forEach(token => broker.revoke(token));
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
