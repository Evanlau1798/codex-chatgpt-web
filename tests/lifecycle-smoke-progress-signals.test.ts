import { expect, test } from "bun:test";
import { CodexLifecycleProgressSignals } from "../scripts/lifecycle-smoke/progress-signals";

test("Codex lifecycle signals distinguish semantic output from status noise", () => {
  const signals = new CodexLifecycleProgressSignals();
  expect(signals.fromRpc({ method: "thread/tokenUsage/updated", params: {} })).toEqual({ kind: "liveness" });
  expect(signals.fromRpc({
    method: "item/agentMessage/delta",
    params: { itemId: "message", delta: "new text" },
  })).toEqual({ kind: "semantic_progress" });
  expect(signals.fromRpc({
    method: "item/completed",
    params: { item: { id: "tool", type: "commandExecution" } },
  })).toEqual({ kind: "semantic_progress" });
  expect(signals.fromRpc({
    method: "item/completed",
    params: { item: { id: "tool", type: "commandExecution" } },
  })).toEqual({ kind: "liveness" });
});

test("launcher heartbeats and repeated reasoning labels are liveness only", () => {
  const signals = new CodexLifecycleProgressSignals();
  expect(signals.fromLauncher({
    at: new Date().toISOString(),
    event: "browser.turn_heartbeat",
    detail: { traceId: "trace" },
  })).toEqual({ kind: "liveness" });
  expect(signals.fromRpc({
    method: "item/completed",
    params: { item: { id: "reasoning", type: "reasoning", summary: ["Web search in progress"] } },
  })).toEqual({ kind: "liveness" });
});

test("content-free daemon activity telemetry creates and retires native tool proof", () => {
  const signals = new CodexLifecycleProgressSignals();
  expect(signals.fromLauncher({
    at: new Date().toISOString(),
    event: "runtime.daemon_stdout",
    detail: { line: "[chatgpt-web] native-tool-activity trace=abc state=active kind=web_search evidence=streaming_busy" },
  })).toEqual({ kind: "native_tool_proof", activity: "web_search" });
  expect(signals.fromLauncher({
    at: new Date().toISOString(),
    event: "runtime.daemon_stdout",
    detail: { line: "[chatgpt-web] native-tool-activity trace=abc state=inactive reason=dom_absent" },
  })).toEqual({ kind: "native_tool_inactive" });
});

test("unstructured or content-bearing daemon lines never become native tool proof", () => {
  const signals = new CodexLifecycleProgressSignals();
  expect(signals.fromLauncher({
    at: new Date().toISOString(),
    event: "runtime.daemon_stdout",
    detail: { line: "Searching private query text" },
  })).toEqual({ kind: "liveness" });
  expect(signals.fromLauncher({
    at: new Date().toISOString(),
    event: "runtime.daemon_stdout",
    detail: { line: "[chatgpt-web] native-tool-activity trace=abc state=active kind=other evidence=streaming_busy" },
  })).toEqual({ kind: "liveness" });
});
