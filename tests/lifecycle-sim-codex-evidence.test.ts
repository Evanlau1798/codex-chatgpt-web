import { describe, expect, test } from "bun:test";
import {
  assertCodexLifecycleRequests,
  assertCodexWaitResult,
  digestLifecyclePayload as digest,
} from "../scripts/lifecycle-sim/codex-evidence";

type Role = "root" | "child" | "grandchild";
type Call = { callId: string; name: string; argumentsDigest: string; index: number };
type Output = { callId: string; outputDigest: string; index: number };

const names = {
  root: ["spawn_agent", "wait_agent", "wait_agent", "followup_task", "wait_agent"],
  child: ["spawn_agent", "wait_agent"],
  grandchild: [],
} satisfies Record<Role, string[]>;
const steps = { root: 6, child: 4, grandchild: 1 } satisfies Record<Role, number>;
const agents = {
  root: "/root",
  child: "/root/lifecycle_child",
  grandchild: "/root/lifecycle_child/lifecycle_grandchild",
} satisfies Record<Role, string>;

function evidence() {
  return (Object.keys(steps) as Role[]).flatMap(role => (
    Array.from({ length: steps[role] }, (_, step) => {
      const count = role === "root" ? step : role === "child" ? Math.min(step, 2) : 0;
      const offset = step % 2;
      const functionCalls: Call[] = names[role].slice(0, count).map((name, index) => ({
        callId: `${role}-${index}`,
        name,
        argumentsDigest: digest(`${role}-arguments-${index}`),
        index: offset + index * 2,
      }));
      const functionOutputs: Output[] = functionCalls.map((call, index) => ({
        callId: call.callId,
        outputDigest: digest(`${role}-output-${index}`),
        index: offset + index * 2 + 1,
      }));
      return {
        role,
        step,
        threadId: `${role}-thread`,
        agentName: agents[role],
        inputTypes: [],
        functionCalls,
        functionOutputs,
      };
    })
  ));
}

function validate(values = evidence()) {
  assertCodexLifecycleRequests(values, "v2");
}

describe("Codex deterministic lifecycle request evidence", () => {
  test("REG-01: timeout evidence cannot hide a terminal, aborted, or missing target", () => {
    const running = { pending: true, completed: false, aborted: false };
    for (const result of [{ timed_out: true }, { status: {}, timed_out: true }]) {
      expect(() => assertCodexWaitResult(result, true, running)).not.toThrow();
      expect(() => assertCodexWaitResult({ ...result, timed_out: false }, true, running)).toThrow("REG-01");
      expect(() => assertCodexWaitResult(result, true, { ...running, pending: false })).toThrow("REG-01");
      expect(() => assertCodexWaitResult(result, true, { ...running, aborted: true })).toThrow("REG-01");
      expect(() => assertCodexWaitResult(result, true, { ...running, completed: true })).toThrow("REG-01");
    }
    expect(() => assertCodexWaitResult({ timed_out: true, status: { child: "running" } }, true,
      { ...running, id: "child" })).not.toThrow();
    for (const status of ["not_found", { completed: "premature" }, { errored: "failure" }]) {
      expect(() => assertCodexWaitResult({ timed_out: true, status: { child: status } }, true,
        { ...running, id: "child" })).toThrow("REG-01");
    }
    const completed = { pending: false, completed: true, aborted: false, id: "child" };
    expect(() => assertCodexWaitResult({ timed_out: false, status: { child: { completed: "CHILD_LIFECYCLE_OK" } } },
      false, completed)).not.toThrow();
    expect(() => assertCodexWaitResult({ timed_out: false, status: {} }, false, completed)).toThrow("REG-01");
  });
  test("accepts append-only history despite shifted absolute input indexes", () => {
    expect(validate).not.toThrow();
  });

  test.each([
    ["call ID rewrite", (values: ReturnType<typeof evidence>) => {
      values[2]!.functionCalls[0]!.callId = "rewritten";
      values[2]!.functionOutputs[0]!.callId = "rewritten";
    }],
    ["arguments rewrite", (values: ReturnType<typeof evidence>) => {
      values[2]!.functionCalls[0]!.argumentsDigest = digest("rewritten arguments");
    }],
    ["output rewrite", (values: ReturnType<typeof evidence>) => {
      values[2]!.functionOutputs[0]!.outputDigest = digest("rewritten output");
    }],
    ["historical call and result replacement", (values: ReturnType<typeof evidence>) => {
      values[3]!.functionCalls[1]!.callId = "replacement";
      values[3]!.functionOutputs[1]!.callId = "replacement";
    }],
    ["result reordering", (values: ReturnType<typeof evidence>) => {
      values[3]!.functionCalls[1]!.index = 1;
      values[3]!.functionOutputs[0]!.index = 3;
      values[3]!.functionOutputs[1]!.index = 2;
    }],
    ["child step 3 drops step 2 history", (values: ReturnType<typeof evidence>) => {
      const childStep3 = values.find(value => value.role === "child" && value.step === 3)!;
      childStep3.functionCalls[0]!.callId = "new-child-call";
      childStep3.functionOutputs[0]!.callId = "new-child-call";
    }],
  ])("rejects %s across adjacent requests", (_label, mutate) => {
    const values = evidence();
    mutate(values);
    expect(() => validate(values)).toThrow(/append-only history/i);
  });

  test("rejects duplicate results and cross-role thread reuse", () => {
    const duplicate = evidence();
    duplicate[1]!.functionOutputs.push({ ...duplicate[1]!.functionOutputs[0]!, index: 99 });
    expect(() => validate(duplicate)).toThrow(/duplicate|exact/i);

    const reused = evidence();
    reused.find(value => value.role === "child")!.threadId = "root-thread";
    expect(() => validate(reused)).toThrow(/thread/i);
  });
});
