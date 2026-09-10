import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTurnBroker, RemoteTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";

test("an ambiguously acknowledged final remains idempotent after completion commits", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-output-final-ack-"));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  const owner = new RemoteTurnBroker(socket);
  try {
    const token = await broker.register({
      cwd: root, roots: [root], writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" }, tools: [],
    }, undefined, "output-final-ack", undefined, true);
    await callTurnBroker(socket, {
      method: "submit_output", token, outputKind: "final", outputText: "Committed.",
    });
    const revision = await owner.beginCompletionFence(token);
    assert.notEqual(revision, undefined);
    assert.equal(await owner.commitCompletionFence(token, revision!), true);

    await expect(callTurnBroker(socket, {
      method: "submit_output", token, outputKind: "final", outputText: "Committed.",
    })).resolves.toMatchObject({ accepted: true, duplicate: true });
    await expect(callTurnBroker(socket, {
      method: "submit_output", token, outputKind: "final", outputText: "Different.",
    })).rejects.toThrow("conflicting final");
    await expect(callTurnBroker(socket, {
      method: "submit_output", token, outputKind: "commentary", outputText: "Late.",
    })).rejects.toThrow("after the final");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
