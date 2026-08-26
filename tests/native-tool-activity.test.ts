import { expect, test } from "bun:test";
import {
  ChatGptNativeToolActivityTracker,
  classifyChatGptNativeToolActivity,
  type ChatGptNativeToolCandidate,
} from "../src/adapters/chatgpt-web/native-tool-activity";

const candidate = (
  overrides: Partial<ChatGptNativeToolCandidate> = {},
): ChatGptNativeToolCandidate => ({
  kind: "web_search",
  withinStreamingStatus: true,
  ancestorsVisible: true,
  ariaBusy: true,
  runningFiniteAnimation: false,
  ...overrides,
});

test("native tool activity requires owned, fully visible, currently active DOM evidence", () => {
  expect(classifyChatGptNativeToolActivity([candidate()])).toEqual({
    kind: "web_search",
    evidence: "streaming_busy",
  });
  expect(classifyChatGptNativeToolActivity([
    candidate({ kind: "native_tool", ariaBusy: false, runningFiniteAnimation: true }),
  ])).toEqual({ kind: "native_tool", evidence: "running_animation" });
  expect(classifyChatGptNativeToolActivity([candidate({ withinStreamingStatus: false })])).toBeUndefined();
  expect(classifyChatGptNativeToolActivity([candidate({ ancestorsVisible: false })])).toBeUndefined();
  expect(classifyChatGptNativeToolActivity([
    candidate({ ariaBusy: false, runningFiniteAnimation: false }),
  ])).toBeUndefined();
});

test("tracker emits an immediate content-free pulse and renews only at the fixed cadence", () => {
  const tracker = new ChatGptNativeToolActivityTracker({
    pulseIntervalMs: 120_000,
    absenceGraceMs: 5_000,
    maxActivityMs: 900_000,
  });
  const activity = classifyChatGptNativeToolActivity([candidate()])!;

  expect(tracker.update(activity, true, 1_000)).toEqual([
    { state: "active", kind: "web_search", evidence: "streaming_busy" },
  ]);
  expect(tracker.update(activity, true, 120_999)).toEqual([]);
  expect(tracker.update(activity, true, 121_000)).toEqual([
    { state: "active", kind: "web_search", evidence: "streaming_busy" },
  ]);
});

test("stale activity reaches a hard ceiling and cannot restart until it disappears", () => {
  const tracker = new ChatGptNativeToolActivityTracker({
    pulseIntervalMs: 120_000,
    absenceGraceMs: 5_000,
    maxActivityMs: 900_000,
  });
  const activity = classifyChatGptNativeToolActivity([candidate()])!;

  tracker.update(activity, true, 10_000);
  expect(tracker.update(activity, true, 910_000)).toEqual([
    { state: "inactive", reason: "lease_ceiling" },
  ]);
  expect(tracker.update(activity, true, 1_030_000)).toEqual([]);
  expect(tracker.update(undefined, true, 1_031_000)).toEqual([]);
  expect(tracker.update(undefined, true, 1_036_000)).toEqual([]);
  expect(tracker.update(activity, true, 1_037_000)).toEqual([
    { state: "active", kind: "web_search", evidence: "streaming_busy" },
  ]);
});

test("absence, generation stop, and changed activity retire the current lease", () => {
  const tracker = new ChatGptNativeToolActivityTracker({
    pulseIntervalMs: 120_000,
    absenceGraceMs: 5_000,
    maxActivityMs: 900_000,
  });
  const search = classifyChatGptNativeToolActivity([candidate()])!;
  const tool = classifyChatGptNativeToolActivity([
    candidate({ kind: "native_tool", ariaBusy: false, runningFiniteAnimation: true }),
  ])!;

  tracker.update(search, true, 1_000);
  expect(tracker.update(tool, true, 2_000)).toEqual([
    { state: "inactive", reason: "activity_changed" },
    { state: "active", kind: "native_tool", evidence: "running_animation" },
  ]);
  expect(tracker.update(undefined, true, 3_000)).toEqual([]);
  expect(tracker.update(undefined, true, 8_000)).toEqual([
    { state: "inactive", reason: "dom_absent" },
  ]);
  tracker.update(search, true, 9_000);
  expect(tracker.update(search, false, 10_000)).toEqual([
    { state: "inactive", reason: "generation_stopped" },
  ]);
});
