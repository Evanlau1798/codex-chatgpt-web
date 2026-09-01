import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";

test("compaction control accepts one structured handoff and consumes it once", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-compaction-control-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    const transaction = await broker.beginCompactionTransaction("trace-control", 10_000);
    const waiting = broker.waitForCompactionHandoff(transaction.token);
    await expect(callTurnBroker(broker.socketPath, {
      method: "submit_compaction_handoff", token: transaction.token,
      handoffId: transaction.handoffId, summary: "Structured checkpoint preserved the implementation state.",
    })).resolves.toEqual({ submitted: true });
    await expect(waiting).resolves.toBe("Structured checkpoint preserved the implementation state.");
    await expect(callTurnBroker(broker.socketPath, {
      method: "submit_compaction_handoff", token: transaction.token,
      handoffId: transaction.handoffId, summary: "Duplicate checkpoint.",
    })).rejects.toThrow();
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("compaction control tokens cannot claim work or use a mismatched handoff id", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-compaction-scope-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    const transaction = await broker.beginCompactionTransaction("trace-scope", 10_000);
    await expect(callTurnBroker(broker.socketPath, { method: "claim", token: transaction.token }))
      .rejects.toThrow("invalid");
    await expect(callTurnBroker(broker.socketPath, {
      method: "submit_compaction_handoff", token: transaction.token,
      handoffId: "handoff_00000000000000000000000000000000", summary: "Structured checkpoint.",
    })).rejects.toThrow("handoff");
    broker.abortCompactionTransaction(transaction.token);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("compaction control fails closed on unusable summaries, timeout, and abort", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-compaction-terminal-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    const invalid = await broker.beginCompactionTransaction("trace-invalid", 10_000);
    await expect(callTurnBroker(broker.socketPath, {
      method: "submit_compaction_handoff", token: invalid.token, handoffId: invalid.handoffId,
      summary: "I cannot create a checkpoint summary because the context is not accessible.",
    })).rejects.toThrow("usable");
    broker.abortCompactionTransaction(invalid.token);
    const timed = await broker.beginCompactionTransaction("trace-timeout", 5);
    await expect(broker.waitForCompactionHandoff(timed.token)).rejects.toThrow("timed out");
    const aborted = await broker.beginCompactionTransaction("trace-abort", 10_000);
    const waiting = broker.waitForCompactionHandoff(aborted.token);
    broker.abortCompactionTransaction(aborted.token);
    await expect(waiting).rejects.toThrow("aborted");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
