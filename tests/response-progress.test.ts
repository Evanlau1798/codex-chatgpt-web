import { expect, test } from "bun:test";
import { ChatGptResponseProgressTracker } from "../src/adapters/chatgpt-web/response-progress";

const snapshot = () => ({ responsePresent: true, markdownRoots: [] as Array<{ text: string; toolEpoch: number }>,
  traceBlocks: [] as Array<{ kind: "status" | "commentary"; text: string; key?: string }>,
  nativeToolCandidates: [] as Array<{ kind: "native_tool"; withinStreamingStatus: boolean;
    ancestorsVisible: boolean; ariaBusy: boolean; runningFiniteAnimation: boolean }> });

test.each(["Réflexion", "Thinking", "思考中"])("only fresh status evidence renews progress: %s", label => {
  const tracker = new ChatGptResponseProgressTracker(), state = snapshot();
  expect(tracker.observe(state, true, 0).progressed).toBeFalse();
  state.traceBlocks.push({ kind: "status", key: "step", text: label });
  expect(tracker.observe(state, true, 1).progressed).toBeTrue();
  expect(tracker.observe(state, true, 300_001).progressed).toBeFalse();
  state.traceBlocks[0]!.text += " 2";
  expect(tracker.observe(state, true, 300_002).progressed).toBeTrue();
  state.traceBlocks[0]!.text = label;
  expect(tracker.observe(state, true, 300_003).progressed).toBeFalse();
});

test("text growth and a later tool boundary count once without publishing text", () => {
  const tracker = new ChatGptResponseProgressTracker(), state = snapshot();
  state.markdownRoots.push({ text: "Partial", toolEpoch: 0 });
  expect(tracker.observe(state, true, 0).progressed).toBeTrue();
  expect(tracker.observe(state, true, 1).progressed).toBeFalse();
  state.markdownRoots[0]!.text += " answer";
  expect(tracker.observe(state, true, 2).progressed).toBeTrue();
  state.markdownRoots[0]!.toolEpoch++;
  expect(tracker.observe(state, true, 3).progressed).toBeTrue();
  expect(tracker.observe(state, true, 300_003).progressed).toBeFalse();
});

test("visible native work retains the existing bounded lease and stops on generation end", () => {
  const tracker = new ChatGptResponseProgressTracker(), state = snapshot();
  state.nativeToolCandidates.push({ kind: "native_tool", withinStreamingStatus: true,
    ancestorsVisible: true, ariaBusy: true, runningFiniteAnimation: false });
  expect(tracker.observe(state, true, 0).progressed).toBeTrue();
  expect(tracker.observe(state, true, 119_999).progressed).toBeFalse();
  expect(tracker.observe(state, true, 120_000).progressed).toBeTrue();
  expect(tracker.observe(state, true, 900_000).progressed).toBeFalse();
  expect(tracker.observe(state, true, 1_200_000).progressed).toBeFalse();
  expect(tracker.observe(state, false, 1_200_001).progressed).toBeFalse();
});

test("hidden, stale and out-of-scope native tool rows cannot renew a wait", () => {
  for (const changed of [{ ancestorsVisible: false }, { withinStreamingStatus: false }, { ariaBusy: false }]) {
    const state = snapshot();
    state.nativeToolCandidates.push({ kind: "native_tool", withinStreamingStatus: true,
      ancestorsVisible: true, ariaBusy: true, runningFiniteAnimation: false, ...changed });
    expect(new ChatGptResponseProgressTracker().observe(state, true).progressed).toBeFalse();
  }
});
