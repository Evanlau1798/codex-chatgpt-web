import { expect, test } from "bun:test";
import {
  CHATGPT_COMPLETION_SETTLE_MS,
  ChatGptCompletionTracker,
  blockingChatGptProjectionAnimations,
  type ChatGptCompletionState,
} from "../src/adapters/chatgpt-web/browser-worker";

const completedState = (
  text: string,
  overrides: Partial<ChatGptCompletionState> = {},
): ChatGptCompletionState => ({
  responsePresent: true,
  running: false,
  currentText: text,
  currentHtml: `<p data-start="0" data-end="${text.length}" data-is-last-node>${text}</p>`,
  completionActionVisible: true,
  projection: {
    rootId: "dom-1",
    lastNodePresent: true,
    boundaryStart: "0",
    boundaryEnd: String(text.length),
    lastMutationAt: 1_000,
    animations: [],
  },
  ...overrides,
});

test("does not complete a terminal prefix while a finite projection animation is active", () => {
  const tracker = new ChatGptCompletionTracker(CHATGPT_COMPLETION_SETTLE_MS, 60_000);
  const animated = completedState("short prefix", {
    projection: {
      ...completedState("").projection,
      animations: [{ playState: "running", currentTime: 10_000, endTime: 20_000, infinite: false }],
    },
  });

  expect(tracker.update(animated, 1_000).status).toBe("waiting");
  expect(tracker.update({
    ...animated,
    projection: {
      ...animated.projection,
      animations: [{ playState: "running", currentTime: 12_000, endTime: 20_000, infinite: false }],
    },
  }, 12_000).status).toBe("waiting");

  const projected = completedState("short prefix followed by the complete answer", {
    projection: {
      ...completedState("").projection,
      boundaryEnd: "44",
      lastMutationAt: 12_500,
      animations: [],
    },
  });
  expect(tracker.update(projected, 12_500).status).toBe("waiting");
  expect(tracker.update(projected, 14_499).status).toBe("waiting");
  expect(tracker.update(projected, 14_500).status).toBe("complete");
});

test("resets completion stability after DOM mutation, root replacement, or resumed generation", () => {
  const tracker = new ChatGptCompletionTracker(2_000, 60_000);
  const initial = completedState("complete answer");

  expect(tracker.update(initial, 1_000).status).toBe("waiting");
  expect(tracker.update({
    ...initial,
    projection: { ...initial.projection, lastMutationAt: 2_500 },
  }, 3_000).status).toBe("waiting");
  expect(tracker.update({
    ...initial,
    projection: { ...initial.projection, rootId: "dom-2", lastMutationAt: 3_500 },
  }, 4_000).status).toBe("waiting");
  expect(tracker.update({ ...initial, running: true }, 6_000).status).toBe("waiting");
  expect(tracker.update(initial, 7_000).status).toBe("waiting");
  expect(tracker.update(initial, 9_000).status).toBe("complete");
});

test("requires a public final-node marker before completing", () => {
  const tracker = new ChatGptCompletionTracker(2_000, 60_000);
  const missingBoundary = completedState("apparently stable", {
    projection: {
      ...completedState("").projection,
      lastNodePresent: false,
      boundaryStart: undefined,
      boundaryEnd: undefined,
    },
  });

  expect(tracker.update(missingBoundary, 1_000).status).toBe("waiting");
  expect(tracker.update(missingBoundary, 20_000).status).toBe("waiting");
});

test("requires stable public start and end boundaries", () => {
  const tracker = new ChatGptCompletionTracker(2_000, 60_000);
  const missingEnd = completedState("apparently stable", {
    projection: {
      ...completedState("").projection,
      boundaryEnd: undefined,
    },
  });

  expect(tracker.update(missingEnd, 1_000).status).toBe("waiting");
  expect(tracker.update(missingEnd, 20_000).status).toBe("waiting");
});

test("ignores infinite decoration but blocks pending and running finite animations", () => {
  const animations = [
    { playState: "running", currentTime: 500, endTime: null, infinite: true },
    { playState: "finished", currentTime: 1_000, endTime: 1_000, infinite: false },
    { playState: "pending", currentTime: null, endTime: 2_000, infinite: false },
    { playState: "running", currentTime: 250, endTime: 2_000, infinite: false },
  ] as const;

  expect(blockingChatGptProjectionAnimations(animations)).toEqual([animations[2], animations[3]]);
});

test("fails closed after terminal projection makes no progress", () => {
  const tracker = new ChatGptCompletionTracker(2_000, 5_000);
  const incomplete = completedState("stable prefix", {
    projection: {
      ...completedState("").projection,
      lastNodePresent: false,
      boundaryEnd: undefined,
    },
  });

  expect(tracker.update(incomplete, 1_000).status).toBe("waiting");
  const failed = tracker.update(incomplete, 6_000);
  expect(failed.status).toBe("stalled");
  if (failed.status !== "stalled") throw new Error("expected stalled projection");
  expect(failed.diagnostic).toEqual({
    textChars: 13,
    boundaryStart: "0",
    boundaryEnd: null,
    blockingAnimations: 0,
    stalledMs: 5_000,
  });
});
