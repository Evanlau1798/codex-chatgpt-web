import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultBrokerEndpoint } from "../src/config";
import { callTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";

async function fixture(run: (broker: TurnBroker, socket: string, token: string, bindingId: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "cgw-gateway-wait-"));
  const socket = defaultBrokerEndpoint(root), broker = TurnBroker.forSocket(socket);
  const token = await broker.register({ cwd: root, roots: [root], writableRoots: [],
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    tools: [{ name: "exec", freeform: true, description: "Gateway", parameters: {} }],
  }, 60_000, "gateway-wait", undefined, true);
  try {
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(socket, {
      method: "claim", token, activityId: "activity_1234567890123456",
    });
    await callTurnBroker(socket, { method: "activity_complete", token, activityId: "activity_1234567890123456" });
    await run(broker, socket, token, bindingId);
  } finally {
    broker.revoke(token);
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function execute(program: string, result: unknown): Promise<BrokerToolResult> {
  const output: string[] = [], AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  await new AsyncFunction("tools", "ALL_TOOLS", "text", program)(
    { multi_agent_v2__wait_agent: async () => result }, [{ name: "multi_agent_v2__wait_agent" }],
    (value: unknown) => output.push(typeof value === "string" ? value : JSON.stringify(value)),
  );
  return { content: [{ type: "text", text: "Script completed\nOutput:\n" + output.join("\n") + "\n" }] };
}

test.each([false, true])("gateway wait decodes structured timeout/error before deciding another slice (error=%s)", async isError => {
  await fixture(async (broker, socket, token, bindingId) => {
    const receipt = await callTurnBroker<{ wait_id: string }>(socket, { method: "start_agent_wait", bindingId,
      wireName: "multi_agent_v2__wait_agent", arguments: { targets: ["child"], timeout_ms: 60_000 } });
    const [first] = await broker.nextToolBatch(token, AbortSignal.timeout(2_000));
    const pending = { timed_out: true, status: {} };
    broker.completeTool(token, first!.callId, await execute(first!.input!, { content: [], structuredContent: pending, isError }));
    let expected = pending;
    if (!isError) {
      const [second] = await broker.nextToolBatch(token, AbortSignal.timeout(500));
      expect(second!.callId).not.toBe(first!.callId);
      expected = { timed_out: false, status: { child: { completed: "done" } } };
      broker.completeTool(token, second!.callId, await execute(second!.input!, { content: [], structuredContent: expected }));
    }
    expect(broker.beginCompletionFence(token)).toBeUndefined();
    const ready = await callTurnBroker<{ operation_status: string; result: BrokerToolResult }>(socket, {
      method: "read_agent_wait", token, waitId: receipt.wait_id,
    });
    expect(ready.operation_status).toBe("ready");
    expect(ready.result.structuredContent).toEqual(expected);
    expect(ready.result.isError === true).toBe(isError);
    expect(JSON.stringify(ready.result)).not.toContain("codex-tool-result:");
    expect(broker.beginCompletionFence(token)).toBeNumber();
  });
});

test("malformed gateway wait metadata retires ownership instead of retrying or leaking activity", async () => {
  await fixture(async (broker, socket, token, bindingId) => {
    await callTurnBroker(socket, { method: "start_agent_wait", bindingId,
      wireName: "multi_agent_v2__wait_agent", arguments: { targets: ["child"], timeout_ms: 60_000 } });
    const [request] = await broker.nextToolBatch(token, AbortSignal.timeout(2_000));
    const wire = await execute(request!.input!, { timed_out: true, status: {} });
    const block = wire.content[0] as { text: string };
    block.text = block.text.replace(/(codex-tool-result:[a-f0-9]+:)[^\n]+/, "$1broken");
    broker.completeTool(token, request!.callId, wire);
    await broker.waitForRetirement(token, AbortSignal.timeout(1_000));
    await expect(broker.nextToolBatch(token)).rejects.toThrow("expired");
  });
});

test.each([false, true])("delivered gateway wait still decodes its own result after compaction (timeout=%s)", async timed_out => {
  await fixture(async (broker, socket, token, bindingId) => {
    const receipt = await callTurnBroker<{ wait_id: string }>(socket, { method: "start_agent_wait", bindingId,
      wireName: "multi_agent_v2__wait_agent", arguments: { targets: ["child"], timeout_ms: 60_000 } });
    const [request] = await broker.nextToolBatch(token, AbortSignal.timeout(2_000));
    const control = { content: [{ type: "text", text: "Compaction handoff required" }] };
    expect(broker.requestCompaction(token, control)).toBe(0);
    const structuredContent = { timed_out, status: {} };
    broker.completeTool(token, request!.callId, await execute(request!.input!, { content: [], structuredContent }));
    const ready = await callTurnBroker<{ operation_status: string; result: BrokerToolResult }>(socket, {
      method: "read_agent_wait", token, waitId: receipt.wait_id,
    });
    expect(ready.operation_status).toBe("ready");
    if (timed_out) expect(ready.result).toEqual(control);
    else expect(ready.result.structuredContent).toEqual(structuredContent);
    expect(JSON.stringify(ready.result)).not.toContain("codex-tool-result:");
    expect(broker.compactionDeliveryCount(token)).toBe(timed_out ? 1 : 0);
    expect(broker.beginCompletionFence(token)).toBeNumber();
  });
});

test("queued gateway wait returns the actual compaction control without decoding it", async () => {
  await fixture(async (broker, socket, token, bindingId) => {
    const receipt = await callTurnBroker<{ wait_id: string }>(socket, { method: "start_agent_wait", bindingId,
      wireName: "multi_agent_v2__wait_agent", arguments: { targets: ["child"], timeout_ms: 60_000 } });
    const control = { content: [{ type: "text", text: "Compaction handoff required" }] };
    expect(broker.requestCompaction(token, control)).toBe(1);
    const ready = await callTurnBroker(socket, { method: "read_agent_wait", token, waitId: receipt.wait_id });
    expect(ready).toEqual({ operation_status: "ready", wait_id: receipt.wait_id, result: control });
    expect(broker.beginCompletionFence(token)).toBeNumber();
  });
});

test("a prior wait slice result cannot settle a later gateway invocation", async () => {
  await fixture(async (broker, socket, token, bindingId) => {
    await callTurnBroker(socket, { method: "start_agent_wait", bindingId,
      wireName: "multi_agent_v2__wait_agent", arguments: { targets: ["child"], timeout_ms: 60_000 } });
    const [first] = await broker.nextToolBatch(token, AbortSignal.timeout(2_000));
    const oldResult = await execute(first!.input!, { content: [], structuredContent: { timed_out: true } });
    broker.completeTool(token, first!.callId, oldResult);
    const [second] = await broker.nextToolBatch(token, AbortSignal.timeout(500));
    expect(second!.callId).not.toBe(first!.callId);
    broker.completeTool(token, second!.callId, oldResult);
    await broker.waitForRetirement(token, AbortSignal.timeout(500));
    await expect(broker.nextToolBatch(token)).rejects.toThrow("expired");
  });
});
