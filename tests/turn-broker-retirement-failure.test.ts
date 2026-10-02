import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { callTurnBroker, TurnBroker, RemoteTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

test.each([false, true])("tool timeout release reaches the %s owner with its original bounded failure", async remote => {
  const root = mkdtempSync(join(tmpdir(), "cgw-retire-failure-"));
  const endpoint = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(endpoint);
  try {
    const token = await broker.register({ cwd: root, roots: [root], writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" }, tools: [] }, 10_000);
    const claimed = await callTurnBroker<{ bindingId: string }>(endpoint, { method: "claim", token });
    const entered = Promise.withResolvers<void>();
    const original = broker.waitForRetirement.bind(broker);
    broker.waitForRetirement = (...args) => { const pending = original(...args); entered.resolve(); return pending; };
    const owner = remote ? new RemoteTurnBroker(endpoint) : broker;
    const retirement = owner.waitForRetirement(token);
    await entered.promise;
    const failure = { code: "codex_tool_timeout", tool: "functions.exec_command", timeoutMs: 90_000 } as const;
    await callTurnBroker(endpoint, { method: "release", bindingId: claimed.bindingId, failure });
    expect(await retirement).toEqual(failure);
    await expect(callTurnBroker(endpoint, { method: "resolve", bindingId: claimed.bindingId })).rejects.toThrow("finished");
  } finally { await broker.close(); rmSync(root, { recursive: true, force: true }); }
});

test("malformed tool timeout metadata cannot retire a valid capability", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-retire-invalid-"));
  const endpoint = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(endpoint);
  try {
    const token = await broker.register({ cwd: root, roots: [root], writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" }, tools: [] }, 10_000);
    const claimed = await callTurnBroker<{ bindingId: string }>(endpoint, { method: "claim", token });
    await expect(callTurnBroker(endpoint, { method: "release", bindingId: claimed.bindingId,
      failure: { code: "codex_tool_timeout", tool: "unsafe/tool", timeoutMs: 0 } }))
      .rejects.toThrow("Invalid Codex tool retirement failure");
    expect(await callTurnBroker(endpoint, { method: "resolve", bindingId: claimed.bindingId })).toHaveProperty("environment");
  } finally { await broker.close(); rmSync(root, { recursive: true, force: true }); }
});
