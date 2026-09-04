import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTurnBroker, RemoteTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";

const nonce = "surface_nonce_admission_0123456789";
const result = { content: [{ type: "text", text: "compact fixture" }] };

test("invalid local safe registration leaves no channel or pending claim", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-admit-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    await expect(broker.registerSafe({
      cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" }, tools: [],
    }, "invalid", undefined, "invalid-registration")).rejects.toThrow("local browser binding is invalid");
    const state = broker as unknown as { channels: Map<string, unknown>; pending: Map<string, unknown> };
    expect(state.channels.size).toBe(0);
    expect(state.pending.size).toBe(0);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["before-sent", "before-start", "completed"])("owner compaction rejects non-running safe state: %s", async phase => {
  const root = mkdtempSync(join(tmpdir(), "cgw-admit-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const remote = new RemoteTurnBroker(broker.socketPath);
  try {
    const request = await broker.registerSafe({
      cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" }, tools: [],
    }, nonce);
    if (phase !== "before-sent") broker.confirmSafeTurnSent(request, nonce);
    if (phase === "completed") {
      broker.startSafeTurn(request);
      broker.completeSafeTurn(request, "final fixture");
    }
    await expect(remote.requestCompaction(request, result)).rejects.toThrow(
      phase === "before-sent" ? "Sent confirmation" : phase === "before-start" ? "not connected yet" : "already terminal",
    );
    expect(broker.compactionDeliveryCount(request)).toBe(0);
    if (phase !== "completed") {
      if (phase === "before-sent") broker.confirmSafeTurnSent(request, nonce);
      broker.startSafeTurn(request);
      // A rejected early compaction must not poison normal harness admission.
      const claim = await callTurnBroker<{ bindingId: string; activityId: string }>(broker.socketPath, {
        method: "claim", token: request, contract: "safe",
      });
      expect(claim.bindingId).toBeString();
      await callTurnBroker(broker.socketPath, { method: "activity_complete", token: request, activityId: claim.activityId });
      await expect(remote.requestCompaction(request, result)).resolves.toBe(0);
    }
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
