import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptCompletionTracker } from "../src/adapters/chatgpt-web/completion-tracker";
import { callTurnBroker, RemoteTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";

const environment = (root: string) => ({
  cwd: root,
  roots: [root],
  writableRoots: [root],
  sandboxPolicy: { type: "dangerFullAccess" as const },
  tools: [],
});

test("broker completion fences reject activity that races a terminal browser decision", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-completion-fence-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register(environment(root));
    const remote = new RemoteTurnBroker(socketPath);
    expect(await remote.beginCompletionFence(token)).toEqual({ revision: 0 });

    const activityId = "activity_abcdefghijklmnop";
    await callTurnBroker(socketPath, { method: "claim", token, activityId });
    expect(await remote.beginCompletionFence(token)).toEqual({ blocked: "activity" });
    expect(await callTurnBroker<{ completed: boolean }>(socketPath, {
      method: "activity_complete",
      token,
      activityId,
    })).toEqual({ completed: true });

    const revision = await remote.beginCompletionFence(token);
    expect(revision).toEqual({ revision: 2 });
    if (!("revision" in revision)) throw new Error("expected a completion fence revision");
    expect(await remote.commitCompletionFence(token, 0)).toBeFalse();
    expect(await remote.commitCompletionFence(token, revision.revision)).toBeTrue();
    await expect(callTurnBroker(socketPath, {
      method: "claim",
      token,
      activityId: "activity_qrstuvwxyzabcdef",
    })).rejects.toThrow("already finished");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote completion fences distinguish an unread retained context archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-completion-context-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  await broker.listen();
  try {
    const remote = new RemoteTurnBroker(socketPath);
    await remote.assertCompatible();
    const token = await broker.register(environment(root));
    await broker.registerContext("updated system", 5_000, "remote-context-fence", token, false);
    expect(await remote.beginCompletionFence(token)).toEqual({ blocked: "context_archive" });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const completionState = (text: string, externalProgressLive = false) => ({
  responsePresent: true,
  running: false,
  currentText: text,
  currentHtml: `<p>${text}</p>`,
  completionActionVisible: true,
  externalProgressLive,
  projection: {
    rootId: "answer",
    boundaryProtocolPresent: false,
    lastNodePresent: true,
    lastMutationAt: 1,
    animations: [],
  },
});

test("recent settled progress does not delay completion and a tool boundary requires a new answer", () => {
  const tracker = new ChatGptCompletionTracker(0, 60_000);
  expect(tracker.update(completionState("pre-tool", true), 10)).toEqual({ status: "waiting" });
  expect(tracker.observeToolBatch(1, "pre-tool")).toBeTrue();
  expect(tracker.update(completionState("pre-tool"), 20)).toEqual({ status: "waiting" });
  expect(tracker.update(completionState("post-tool"), 30)).toEqual({ status: "waiting" });
  expect(tracker.update(completionState("post-tool"), 31)).toEqual({ status: "complete" });
});
