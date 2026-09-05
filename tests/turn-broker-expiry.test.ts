import { expect, test } from "bun:test";
import { extractChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import {
  callTurnBroker,
  TurnBroker,
  type BrokerToolResult,
} from "../src/adapters/chatgpt-web/turn-broker";
import { brokerTestEndpoint, environmentXml, parsed, toolResult } from "./chatgpt-harness-fixture";

test("an accepted MCP invocation survives turn TTL until its result settles", async () => {
  const socketPath = brokerTestEndpoint(`cgw-h3-expiry-${process.pid}-${Date.now()}`);
  const broker = TurnBroker.forSocket(socketPath);
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;

  try {
    const token = await broker.register(
      extractChatGptTurnEnvironment(parsed(environmentXml)),
      100,
    );
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(
      socketPath,
      { method: "claim", token },
    );
    const invocation = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId,
      wireName: "exec_command",
      arguments: { cmd: "echo ready" },
    }, null);
    const outcome = invocation.then(
      value => ({ value }),
      error => ({ error: error instanceof Error ? error : new Error(String(error)) }),
    );
    const [request] = await broker.nextToolBatch(token);
    expect(request).toBeDefined();

    now += 101;
    const result = toolResult({ output: "ok" });
    broker.completeTool(token, request!.callId, result);
    expect(await outcome).toEqual({ value: result });

    await expect(broker.nextToolBatch(token)).rejects.toThrow("invalid or expired");
  } finally {
    Date.now = originalNow;
    await broker.close();
  }
});
