import { describe, expect, test } from "bun:test";
import { assertCodexLifecycleRequests } from "../scripts/lifecycle-sim/codex-evidence";

const request = (
  role: "root" | "child" | "grandchild",
  step: number,
  threadId: string,
  agentName: string,
  inputTypes: string[] = ["message"],
  functionOutputs: string[] = [],
) => ({ role, step, threadId, agentName, inputTypes, functionOutputs });

describe("Codex deterministic lifecycle request evidence", () => {
  test("accepts stable distinct nested ownership and ordered tool results", () => {
    const values = [
      request("root", 0, "root-thread", "/root"),
      request("root", 1, "root-thread", "/root", ["message", "function_call", "function_call_output"], ["spawn"]),
      request("child", 0, "child-thread", "/root/lifecycle_child"),
      request("child", 1, "child-thread", "/root/lifecycle_child", ["agent_message", "function_call", "function_call_output"], ["spawn"]),
      request("grandchild", 0, "grandchild-thread", "/root/lifecycle_child/lifecycle_grandchild"),
    ];
    expect(() => assertCodexLifecycleRequests(values, "v2")).not.toThrow();
  });

  test("rejects cross-role thread reuse, missing results, and reversed ordering", () => {
    expect(() => assertCodexLifecycleRequests([
      request("root", 0, "shared", "/root"),
      request("child", 0, "shared", "/root/lifecycle_child"),
      request("child", 1, "shared", "/root/lifecycle_child", ["function_call_output", "function_call"], []),
    ], "v2")).toThrow(/thread|tool result|ordering/i);
  });
});
