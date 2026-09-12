import { expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTurnBroker, RemoteTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import { submitNativeOutputControl } from "../src/adapters/chatgpt-web/native-output-control";

const environment = (root: string) => ({
  cwd: root, roots: [root], writableRoots: [root],
  sandboxPolicy: { type: "dangerFullAccess" as const }, tools: [],
});

test("turn output is ordered and final delivery is fail closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-output-tunnel-"));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  const owner = new RemoteTurnBroker(socket);
  const log = spyOn(console, "info").mockImplementation(() => {});
  try {
    const token = await broker.register(environment(root), undefined, "output-test", undefined, true);
    const submit = (kind: "commentary" | "reasoning" | "final", text: string) => callTurnBroker<{ duplicate: boolean }>(socket, {
      method: "submit_output", token, outputKind: kind, outputText: text,
    });
    await assert.rejects(callTurnBroker(socket, {
      method: "submit_output", token: "turn_wrong", outputKind: "commentary", outputText: "No.",
    }), /invalid, expired, or revoked/);
    await assert.rejects(callTurnBroker(socket, {
      method: "submit_output", token, outputKind: "unknown" as "commentary", outputText: "No.",
    }), /kind is invalid/);
    await assert.rejects(submit("commentary", ""), /text is invalid/);
    await submit("commentary", "Checking the repository.");
    await submit("reasoning", "The shared boundary is the smallest fix.");
    await submit("final", "Done.");
    assert.deepEqual(await owner.nextOutput(token, 0), { sequence: 1, kind: "commentary", text: "Checking the repository." });
    assert.deepEqual(await owner.nextOutput(token, 1), { sequence: 2, kind: "reasoning", text: "The shared boundary is the smallest fix." });
    assert.deepEqual(await owner.nextOutput(token, 2), { sequence: 3, kind: "final", text: "Done." });
    assert.equal((await submit("final", "Done.")).duplicate, true);
    await assert.rejects(submit("final", "Different."), /conflicting final/);
    await assert.rejects(submit("commentary", "Late."), /after the final/);
    await owner.resetOutput(token, 3);
    const nextAttempt = owner.nextOutput(token, 0);
    assert.equal(await Promise.race([
      nextAttempt.then(() => "replayed"),
      new Promise(resolve => setTimeout(() => resolve("waiting"), 10)),
    ]), "waiting");
    await submit("final", "Retried final.");
    assert.deepEqual(await nextAttempt, { sequence: 4, kind: "final", text: "Retried final." });
    const receipts = log.mock.calls.flat().filter(line => String(line).includes("output accepted"));
    expect(receipts).toHaveLength(5);
    expect(receipts).toContain("[chatgpt-web] broker trace=output-test output accepted kind=final sequence=3 chars=5 duplicate=false");
    expect(receipts).toContain("[chatgpt-web] broker trace=output-test output accepted kind=final sequence=3 chars=5 duplicate=true");
    expect(String(receipts)).toContain("kind=commentary sequence=1");
    expect(String(receipts)).toContain("kind=reasoning sequence=2");
    for (const privateValue of [token, "Checking the repository.", "The shared boundary is the smallest fix.", "Done.", "Retried final."]) {
      expect(String(receipts)).not.toContain(privateValue);
    }
    await broker.revoke(token);
    await assert.rejects(owner.nextOutput(token, 4));
    await assert.rejects(submit("final", "Late."), /invalid, expired, or revoked/);

    const sealedToken = await broker.register(environment(root), undefined, "sealed-output-test", undefined, true);
    assert.equal(await owner.sealOutput(sealedToken, 0), true);
    await assert.rejects(callTurnBroker(socket, {
      method: "submit_output", token: sealedToken, outputKind: "final", outputText: "Too late.",
    }), /DOM fallback was sealed/);
  } finally {
    log.mockRestore();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("final output waits for work settlement and blocks later work until reset", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-output-final-"));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  const owner = new RemoteTurnBroker(socket);
  try {
    const token = await broker.register(environment(root), undefined, "output-final-test", undefined, true);
    const activityId = "activity_1234567890123456";
    await callTurnBroker(socket, { method: "claim", token, activityId });
    await expect(callTurnBroker(socket, {
      method: "submit_output", token, outputKind: "final", outputText: "Too early.",
    })).rejects.toThrow("work tools are still active");
    await callTurnBroker(socket, { method: "activity_complete", token, activityId });
    const submitted = await callTurnBroker<{ sequence: number }>(socket, {
      method: "submit_output", token, outputKind: "final", outputText: "Settled.",
    });
    await expect(callTurnBroker(socket, {
      method: "claim", token, activityId: "activity_abcdefghijklmnop",
    })).rejects.toThrow("final answer is pending");
    await owner.resetOutput(token, submitted.sequence);
    await expect(callTurnBroker(socket, {
      method: "claim", token, activityId: "activity_abcdefghijklmnop",
    })).resolves.toMatchObject({ activityId: "activity_abcdefghijklmnop" });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the hidden MCP output control is scoped to output-enabled turns", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-output-mcp-"));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  try {
    await broker.listen();
    const remote = new RemoteTurnBroker(socket);
    const disabled = await remote.register(environment(root), undefined, "output-disabled-test");
    const enabled = await remote.register(environment(root), undefined, "output-enabled-test", undefined, true);
    await expect(submitNativeOutputControl(
      socket, disabled, { kind: "commentary", text: "Denied." }, undefined,
    )).rejects.toThrow("not enabled");
    await expect(submitNativeOutputControl(
      socket, enabled, { kind: "final", text: "Accepted." }, undefined,
    )).resolves.toMatchObject({ accepted: true });
    expect(await remote.nextOutput(enabled, 0)).toMatchObject({
      kind: "final", text: "Accepted.",
    });
    await expect(remote.nextOutput(disabled, 0)).rejects.toThrow("not enabled");
    await expect(remote.resetOutput(disabled, 1)).rejects.toThrow("not enabled");
    await expect(remote.sealOutput(disabled, 0)).rejects.toThrow("not enabled");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("final output cannot bypass an unread native context archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-output-context-"));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  try {
    const token = await broker.register(environment(root), undefined, "output-context-test", undefined, true);
    const contextToken = await broker.registerContext("required context", 60_000, "output-context-test", token);
    await expect(callTurnBroker(socket, {
      method: "submit_output", token, outputKind: "final", outputText: "Too early.",
    })).rejects.toThrow("context archive");
    await callTurnBroker(socket, { method: "read_context", token: contextToken, index: 0, chunkChars: 1_000 });
    await expect(callTurnBroker(socket, {
      method: "submit_output", token, outputKind: "final", outputText: "Complete.",
    })).resolves.toMatchObject({ accepted: true });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
