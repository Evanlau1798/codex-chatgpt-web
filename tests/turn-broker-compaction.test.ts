import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";

const tool = { name: "exec_command", description: "Run one command", parameters: { type: "object" } };

async function setup(root: string): Promise<{ broker: TurnBroker; token: string; bindingId: string }> {
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const token = await broker.register({
    cwd: root, roots: [root], writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" }, tools: [tool],
  });
  const { bindingId } = await callTurnBroker<{ bindingId: string }>(broker.socketPath, {
    method: "claim", token,
  });
  return { broker, token, bindingId };
}

test("compaction preserves an already delivered call and intercepts only later calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-active-compaction-"));
  const { broker, token, bindingId } = await setup(root);
  try {
    const current = callTurnBroker<BrokerToolResult>(broker.socketPath, {
      method: "invoke", bindingId, wireName: "exec_command", arguments: { cmd: "pwd" },
    });
    const [request] = await broker.nextToolBatch(token);
    broker.requestCompaction(token, { content: [{ type: "text", text: "compact now" }], isError: true });
    broker.completeTool(token, request!.callId, { content: [{ type: "text", text: "current result" }] });
    await expect(current).resolves.toMatchObject({ content: [{ type: "text", text: "current result" }] });
    await expect(callTurnBroker(broker.socketPath, {
      method: "invoke", bindingId, wireName: "exec_command", arguments: { cmd: "git status" },
    })).resolves.toMatchObject({ content: [{ type: "text", text: "compact now" }], isError: true });
    expect(broker.compactionDeliveryCount(token)).toBe(1);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("compaction drains a queued call and retires its delivery counter with the token", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-queued-compaction-"));
  const { broker, token, bindingId } = await setup(root);
  try {
    const invocation = callTurnBroker<BrokerToolResult>(broker.socketPath, {
      method: "invoke", bindingId, wireName: "exec_command", arguments: { cmd: "must-not-run" },
    });
    await Bun.sleep(20);
    expect(broker.requestCompaction(token, {
      content: [{ type: "text", text: "compact instead" }], isError: true,
    })).toBe(1);
    await expect(invocation).resolves.toMatchObject({
      content: [{ type: "text", text: "compact instead" }], isError: true,
    });
    expect(broker.compactionDeliveryCount(token)).toBe(1);
    broker.revoke(token);
    expect(() => broker.compactionDeliveryCount(token)).toThrow("turn capability retired");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
