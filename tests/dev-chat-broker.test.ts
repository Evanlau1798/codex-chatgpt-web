import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callTurnBroker,
  RemoteTurnBroker,
  TurnBroker,
  type BrokerToolResult,
} from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";

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
