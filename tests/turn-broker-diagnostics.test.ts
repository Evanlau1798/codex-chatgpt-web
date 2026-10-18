import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { callTurnBroker, TurnBroker, type BrokerRetirementDiagnostics } from "../src/adapters/chatgpt-web/turn-broker";

const failure = { code: "codex_tool_timeout" as const, tool: "exec_command", timeoutMs: 90_000 };
type Release = { released: boolean; duplicate?: boolean; diagnostics?: BrokerRetirementDiagnostics };

async function fixture(ttlMs?: number) {
  const root = mkdtempSync(join(tmpdir(), "cgw-diagnostics-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const logs: string[] = [];
  let queued!: () => void;
  const info = spyOn(console, "info").mockImplementation(message => {
    logs.push(String(message));
    if (String(message).includes(" queued call=")) queued?.();
  });
  const environment = { cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" as const }, tools: [] };
  const token = await broker.register(environment, ttlMs, "diagnostic-turn");
  const { bindingId } = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
  return {
    root, socketPath, broker, token, bindingId, environment, logs,
    async enqueue(wireName = "exec_command", freeform = false) {
      const accepted = new Promise<void>(resolve => { queued = resolve; });
      const outcome = callTurnBroker(socketPath, {
        method: "invoke", bindingId, wireName, freeform,
        ...(freeform ? { input: "PRIVATE FREEFORM CONTENT" } : { arguments: { cmd: "PRIVATE COMMAND CONTENT" } }),
      }, null).then(() => "completed", () => "rejected");
      await accepted;
      return { outcome };
    },
    release: () => callTurnBroker<Release>(socketPath, { method: "release", bindingId, failure }),
    async close() {
      try { await broker.close(); }
      finally { info.mockRestore(); rmSync(root, { recursive: true, force: true }); }
    },
  };
}

test("retirement diagnostics distinguish queue time from result wait and exclude completed calls and private content", async () => {
  const f = await fixture();
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  try {
    const completed = await f.enqueue("completed_tool");
    const [completedCall] = await f.broker.nextToolBatch(f.token);
    f.broker.completeTool(f.token, completedCall!.callId, { content: [{ type: "text", text: "PRIVATE TOOL OUTPUT" }] });
    expect(await completed.outcome).toBe("completed");

    now = 100;
    const delivered = await f.enqueue();
    now = 200;
    const [deliveredCall] = await f.broker.nextToolBatch(f.token);
    now = 300;
    expect(f.broker.beginCompletionFence(f.token)).toBeUndefined();
    now = 400;
    const queued = await f.enqueue("exec", true);
    now = 1_000;
    const released = await f.release();
    expect(released.diagnostics).toEqual({
      traceId: "diagnostic-turn", pendingTools: 2, queuedTools: 1, deliveredTools: 1,
      activeMcpRequests: 1, completionCommitted: false, omittedPendingCalls: 0,
      pendingCalls: [
        { callRef: deliveredCall!.callId.slice(0, 17), tool: "exec_command", state: "delivered", queuedMs: 100, awaitingResultMs: 800 },
        { callRef: expect.any(String), tool: "exec", state: "queued", queuedMs: 600 },
      ],
    });
    const event = f.logs.find(line => line.includes(" broker_retired "))!;
    expect(JSON.parse(event.split(" broker_retired ")[1]!)).toEqual({ ...released.diagnostics, failure });
    const diagnosticText = JSON.stringify(released);
    for (const privateValue of ["PRIVATE", f.root, f.token, f.bindingId, "completed_tool"]) {
      expect(diagnosticText).not.toContain(privateValue);
      expect(event).not.toContain(privateValue);
    }
    expect(await delivered.outcome).toBe("rejected");
    expect(await queued.outcome).toBe("rejected");
    await expect(callTurnBroker(f.socketPath, { method: "invoke", bindingId: f.bindingId, wireName: "exec_command" }))
      .rejects.toThrow("already finished");
  } finally { clock.mockRestore(); await f.close(); }
});

test("expiry preserves the original retirement diagnostics for late timeout cleanup without reviving calls", async () => {
  const f = await fixture(10_000);
  const originalNow = Date.now();
  let elapsed = 100;
  const timer = spyOn(performance, "now").mockImplementation(() => elapsed);
  const clock = spyOn(Date, "now").mockReturnValue(originalNow);
  try {
    const queued = await f.enqueue();
    elapsed = 600;
    clock.mockReturnValue(originalNow + 20_000);
    expect(await callTurnBroker(f.socketPath, { method: "resolve", bindingId: f.bindingId })).toBeDefined();
    const [call] = await f.broker.nextToolBatch(f.token);
    f.broker.completeTool(f.token, call!.callId, { content: [] });
    expect(await queued.outcome).toBe("completed");
    // After active work settles, the real expiry path retires the channel.
    await expect(callTurnBroker(f.socketPath, { method: "resolve", bindingId: f.bindingId })).rejects.toThrow("already finished");
    elapsed = 1_000;
    const released = await f.release();
    expect(released).toMatchObject({ released: true, duplicate: true, diagnostics: {
      pendingTools: 0, queuedTools: 0, deliveredTools: 0,
      pendingCalls: [],
    } });
    elapsed = 2_000;
    expect(await f.release()).toEqual(released);
    await expect(callTurnBroker(f.socketPath, {
      method: "release", bindingId: f.bindingId, failure: { ...failure, timeoutMs: -1 },
    })).rejects.toThrow("Invalid Codex tool retirement failure");
    await expect(callTurnBroker(f.socketPath, { method: "claim", token: f.token })).rejects.toThrow("already finished");
  } finally { timer.mockRestore(); clock.mockRestore(); await f.close(); }
});

test("retirement diagnostics cap call details while keeping complete counts and evict with the existing history", async () => {
  const f = await fixture();
  try {
    const pending = [];
    for (let i = 0; i < 18; i += 1) pending.push(await f.enqueue());
    const released = await f.release();
    expect(released.diagnostics).toMatchObject({ pendingTools: 18, queuedTools: 18, deliveredTools: 0, omittedPendingCalls: 2 });
    expect(released.diagnostics!.pendingCalls).toHaveLength(16);
    expect(await Promise.all(pending.map(call => call.outcome))).toEqual(Array(18).fill("rejected"));

    // Ordinary releases keep their existing response and share the same bounded history.
    for (let i = 0; i < 64; i += 1) {
      const token = await f.broker.register(f.environment);
      const { bindingId } = await callTurnBroker<{ bindingId: string }>(f.socketPath, { method: "claim", token });
      expect(await callTurnBroker<Release>(f.socketPath, { method: "release", bindingId })).toEqual({ released: true });
    }
    await expect(f.release()).rejects.toThrow("invalid or expired");
  } finally { await f.close(); }
});
