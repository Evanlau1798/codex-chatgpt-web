import { describe, expect, test } from "bun:test";
import { assertCodexLifecycleRequests } from "../scripts/lifecycle-sim/codex-evidence";

const request = (
  role: "root" | "child" | "grandchild",
  step: number,
  threadId: string,
  agentName: string,
  inputTypes: string[] = ["message"],
  functionCalls: Array<{ callId: string; name: string; index: number }> = [],
  functionOutputs: Array<{ callId: string; output: string; index: number }> = [],
) => ({ role, step, threadId, agentName, inputTypes, functionCalls, functionOutputs });

describe("Codex deterministic lifecycle request evidence", () => {
  test("accepts stable distinct nested ownership and ordered tool results", () => {
    const values = [
      request("root", 0, "root-thread", "/root"),
      request("root", 1, "root-thread", "/root", ["message", "function_call", "function_call_output"],
        [{ callId: "root-spawn", name: "spawn_agent", index: 1 }],
        [{ callId: "root-spawn", output: "spawn", index: 2 }]),
      request("root", 2, "root-thread", "/root", ["function_call", "function_call_output", "function_call", "function_call_output"],
        [
          { callId: "root-spawn", name: "spawn_agent", index: 0 },
          { callId: "root-wait", name: "wait_agent", index: 2 },
        ], [
          { callId: "root-spawn", output: "spawn", index: 1 },
          { callId: "root-wait", output: "wait", index: 3 },
        ]),
      request("root", 3, "root-thread", "/root", ["function_call", "function_call_output", "function_call", "function_call_output", "function_call", "function_call_output"],
        [
          { callId: "root-spawn", name: "spawn_agent", index: 0 },
          { callId: "root-wait", name: "wait_agent", index: 2 },
          { callId: "root-followup", name: "followup_task", index: 4 },
        ], [
          { callId: "root-spawn", output: "spawn", index: 1 },
          { callId: "root-wait", output: "wait", index: 3 },
          { callId: "root-followup", output: "followup", index: 5 },
        ]),
      request("root", 4, "root-thread", "/root", ["function_call", "function_call_output", "function_call", "function_call_output", "function_call", "function_call_output", "function_call", "function_call_output"],
        [
          { callId: "root-spawn", name: "spawn_agent", index: 0 },
          { callId: "root-wait", name: "wait_agent", index: 2 },
          { callId: "root-followup", name: "followup_task", index: 4 },
          { callId: "root-wait-2", name: "wait_agent", index: 6 },
        ], [
          { callId: "root-spawn", output: "spawn", index: 1 },
          { callId: "root-wait", output: "wait", index: 3 },
          { callId: "root-followup", output: "followup", index: 5 },
          { callId: "root-wait-2", output: "wait", index: 7 },
        ]),
      request("child", 0, "child-thread", "/root/lifecycle_child"),
      request("child", 1, "child-thread", "/root/lifecycle_child", ["agent_message", "function_call", "function_call_output"],
        [{ callId: "child-spawn", name: "spawn_agent", index: 1 }],
        [{ callId: "child-spawn", output: "spawn", index: 2 }]),
      request("child", 2, "child-thread", "/root/lifecycle_child", ["function_call", "function_call_output", "function_call", "function_call_output"],
        [
          { callId: "child-spawn", name: "spawn_agent", index: 0 },
          { callId: "child-wait", name: "wait_agent", index: 2 },
        ], [
          { callId: "child-spawn", output: "spawn", index: 1 },
          { callId: "child-wait", output: "wait", index: 3 },
        ]),
      request("child", 3, "child-thread", "/root/lifecycle_child", ["function_call", "function_call_output", "function_call", "function_call_output"],
        [
          { callId: "child-spawn", name: "spawn_agent", index: 0 },
          { callId: "child-wait", name: "wait_agent", index: 2 },
        ], [
          { callId: "child-spawn", output: "spawn", index: 1 },
          { callId: "child-wait", output: "wait", index: 3 },
        ]),
      request("grandchild", 0, "grandchild-thread", "/root/lifecycle_child/lifecycle_grandchild"),
    ];
    expect(() => assertCodexLifecycleRequests(values, "v2")).not.toThrow();
  });

  test("rejects cross-role thread reuse, missing results, and reversed ordering", () => {
    expect(() => assertCodexLifecycleRequests([
      request("root", 0, "shared", "/root"),
      request("child", 0, "shared", "/root/lifecycle_child"),
      request("child", 1, "shared", "/root/lifecycle_child", ["function_call_output", "function_call"],
        [{ callId: "call", name: "spawn_agent", index: 1 }],
        [{ callId: "wrong", output: "result", index: 0 }]),
    ], "v2")).toThrow(/thread|tool result|ordering|call id/i);
  });

  test("rejects extra rounds, duplicate results, and mismatched call ids", () => {
    const base = request("root", 0, "root-thread", "/root");
    expect(() => assertCodexLifecycleRequests([base, { ...base, step: 5 }], "v2"))
      .toThrow(/exact lifecycle steps/i);
    expect(() => assertCodexLifecycleRequests([
      request("root", 0, "root-thread", "/root"),
      request("root", 1, "root-thread", "/root", ["function_call", "function_call_output", "function_call_output"],
        [{ callId: "spawn", name: "spawn_agent", index: 0 }],
        [
          { callId: "spawn", output: "one", index: 1 },
          { callId: "spawn", output: "two", index: 2 },
        ]),
    ], "v2")).toThrow(/duplicate|exact/i);
    expect(() => assertCodexLifecycleRequests([
      request("root", 0, "root-thread", "/root"),
      request("root", 1, "root-thread", "/root", ["function_call", "function_call_output"],
        [{ callId: "spawn", name: "spawn_agent", index: 0 }],
        [{ callId: "other", output: "one", index: 1 }]),
    ], "v2")).toThrow(/call id/i);
  });
});
