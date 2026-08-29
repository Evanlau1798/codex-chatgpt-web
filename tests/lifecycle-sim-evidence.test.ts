import { expect, test } from "bun:test";
import { assertLifecycleEvidence, assertSingleLifecycleEvidence } from "../scripts/lifecycle-sim/evidence";

test("deterministic lifecycle evidence rejects missing and out-of-order phases", () => {
  expect(() => assertLifecycleEvidence(
    ["request", "tool_call", "tool_result", "compact", "interrupt", "resume", "idle"],
    ["request", "tool_call", "tool_result", "compact", "interrupt", "resume", "idle"],
  )).not.toThrow();
  expect(() => assertLifecycleEvidence(
    ["request", "tool_call", "compact", "interrupt", "resume", "idle"],
    ["request", "tool_call", "tool_result", "compact", "interrupt", "resume", "idle"],
  )).toThrow("missing lifecycle phase: tool_result");
  expect(() => assertLifecycleEvidence(
    ["request", "tool_result", "tool_call", "compact", "interrupt", "resume", "idle"],
    ["request", "tool_call", "tool_result", "compact", "interrupt", "resume", "idle"],
  )).toThrow("out of order");
});

test("single lifecycle evidence rejects duplicate steering delivery", () => {
  expect(() => assertSingleLifecycleEvidence(["steering_active", "steering"], "steering")).not.toThrow();
  expect(() => assertSingleLifecycleEvidence(["steering", "steering"], "steering"))
    .toThrow("expected exactly one lifecycle phase: steering");
});
