import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptCompletionTracker } from "../src/adapters/chatgpt-web/completion-tracker";
import { callTurnBroker, RemoteTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import {
  ChatGptFinalAnswerDecisionError,
  decideChatGptFinalAnswer,
} from "../src/adapters/chatgpt-web/final-answer-gate";
import { ChatGptSteeringFeed } from "../src/adapters/chatgpt-web/steering-feed";
import { ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";

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
    expect(await remote.beginCompletionFence(token)).toBe(0);

    const activityId = "activity_abcdefghijklmnop";
    await callTurnBroker(socketPath, { method: "claim", token, activityId });
    expect(await remote.beginCompletionFence(token)).toBeUndefined();
    expect(await callTurnBroker<{ completed: boolean }>(socketPath, {
      method: "activity_complete",
      token,
      activityId,
    })).toEqual({ completed: true });

    const revision = await remote.beginCompletionFence(token);
    expect(revision).toBe(2);
    expect(await remote.commitCompletionFence(token, 0)).toBeFalse();
    expect(await remote.commitCompletionFence(token, revision!)).toBeTrue();
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

test("an answer retry keeps the completion fence open for later tool activity", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-answer-retry-fence-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register(environment(root));
    const remote = new RemoteTurnBroker(socketPath);
    const revision = await remote.beginCompletionFence(token);
    expect(await decideChatGptFinalAnswer({
      answer: "unfinished",
      attempt: 1,
      retryPromptForAnswer: () => "continue",
      completionFence: { commit: value => remote.commitCompletionFence(token, value) },
      completionFenceRevision: revision,
    })).toEqual({ status: "retry", retry: { text: "continue" } });

    const activityId = "activity_retryabcdefghijk";
    await expect(callTurnBroker(socketPath, { method: "claim", token, activityId })).resolves.toBeDefined();
    await callTurnBroker(socketPath, { method: "activity_complete", token, activityId });

    const finalRevision = await remote.beginCompletionFence(token);
    expect(await decideChatGptFinalAnswer({
      answer: "complete",
      attempt: 2,
      completionFence: { commit: value => remote.commitCompletionFence(token, value) },
      completionFenceRevision: finalRevision,
    })).toEqual({ status: "complete", answer: "complete" });
    await expect(callTurnBroker(socketPath, {
      method: "claim", token, activityId: "activity_aftercompletionx",
    })).rejects.toThrow("already finished");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a completion race returns to observation without retiring the owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-answer-race-fence-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register(environment(root));
    const remote = new RemoteTurnBroker(socketPath);
    const revision = await remote.beginCompletionFence(token);
    const activityId = "activity_raceabcdefghijkl";
    await callTurnBroker(socketPath, { method: "claim", token, activityId });
    let finalized = 0;
    expect(await decideChatGptFinalAnswer({
      answer: "stale",
      attempt: 1,
      completionFence: { commit: value => remote.commitCompletionFence(token, value) },
      completionFenceRevision: revision,
      finalizeAnswer: () => { finalized += 1; return "stale"; },
    })).toEqual({ status: "observe" });
    expect(finalized).toBe(0);
    await expect(callTurnBroker(socketPath, {
      method: "claim", token, activityId: "activity_raceponmlkjihgfe",
    })).resolves.toBeDefined();
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retry selection errors leave the completion fence open", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-answer-error-fence-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register(environment(root));
    const remote = new RemoteTurnBroker(socketPath);
    const revision = await remote.beginCompletionFence(token);
    const failure = decideChatGptFinalAnswer({
      answer: "candidate",
      attempt: 1,
      retryPromptForAnswer: () => { throw new Error("retry failed"); },
      completionFence: { commit: value => remote.commitCompletionFence(token, value) },
      completionFenceRevision: revision,
    });
    await expect(failure).rejects.toBeInstanceOf(ChatGptFinalAnswerDecisionError);
    await expect(failure).rejects.toThrow("retry failed");
    await expect(callTurnBroker(socketPath, {
      method: "claim", token, activityId: "activity_errorabcdefghijk",
    })).resolves.toBeDefined();
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a preemptive retry takes priority without consulting the answer retry", async () => {
  let answerRetryCalls = 0;
  let completionCommits = 0;
  expect(await decideChatGptFinalAnswer({
    answer: "candidate",
    attempt: 1,
    preemptiveRetryPrompt: "checkpoint",
    retryPromptForAnswer: () => {
      answerRetryCalls += 1;
      return "answer retry";
    },
    completionFence: { commit: async () => { completionCommits += 1; return true; } },
    completionFenceRevision: 0,
  })).toEqual({ status: "retry", retry: { text: "checkpoint" } });
  expect(answerRetryCalls).toBe(0);
  expect(completionCommits).toBe(0);
});

test("finalizes output only after the completion fence commits", async () => {
  const order: string[] = [];
  expect(await decideChatGptFinalAnswer({
    answer: "preview",
    attempt: 1,
    completionFence: { commit: async () => { order.push("commit"); return true; } },
    completionFenceRevision: 0,
    finalizeAnswer: () => { order.push("finalize"); return "final"; },
  })).toEqual({ status: "complete", answer: "final" });
  expect(order).toEqual(["commit", "finalize"]);
});

test("a steering admission invalidates an in-flight completion revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-steering-fence-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    const token = await broker.register(environment(root));
    const revision = await broker.beginCompletionFence(token);
    expect(broker.requestSteering(token, "continue with the new constraint")).toBe("queued");
    expect(await broker.commitCompletionFence(token, revision!)).toBeFalse();
    const current = await broker.beginCompletionFence(token);
    expect(await broker.commitCompletionFence(token, current!)).toBeTrue();
    expect(() => broker.requestSteering(token, "too late")).toThrow("already finished");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude steering refuses admission while final completion is sealed", () => {
  const steering = new ChatGptSteeringFeed();
  expect(steering.sealCompletion()).toBeTrue();
  expect(steering.canAccept()).toBeFalse();
  expect(steering.pushClaude("late steering", "delivery-late")).toBeFalse();
  expect(steering.peek()).toBeUndefined();
  steering.reopenCompletion();
  expect(steering.pushClaude("retry steering", "delivery-retry")).toBeTrue();
});

test("a novel Claude root revision cannot bypass sealed completion with queue disabled", () => {
  const steering = new ChatGptSteeringFeed();
  const session = new ChatGptTurnSession({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: {} as never,
    text: {} as never,
    steering,
    cancel() {},
  });
  expect(session.updateUserRevision("first", "first", false)).toBeUndefined();
  expect(steering.sealCompletion()).toBeTrue();
  expect(session.canAcceptUserRevision("second", "second", false)).toBeFalse();
  expect(session.updateUserRevision("second", "second", false)).toBe("second");
});

test("abort after answer selection prevents completion commit and finalization", async () => {
  const abort = new AbortController();
  let commits = 0;
  let finalized = 0;
  const decision = decideChatGptFinalAnswer({
    answer: "candidate",
    attempt: 1,
    retryPromptForAnswer: () => { abort.abort(); return undefined; },
    completionFence: { commit: async () => { commits += 1; return true; } },
    completionFenceRevision: 0,
    abortSignal: abort.signal,
    finalizeAnswer: () => { finalized += 1; return "candidate"; },
  });
  await expect(decision).rejects.toThrow("aborted");
  expect(commits).toBe(0);
  expect(finalized).toBe(0);
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
