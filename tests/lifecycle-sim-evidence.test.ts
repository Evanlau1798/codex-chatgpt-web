import { expect, test } from "bun:test";
import { assertClaudeLifecycleEvidence, assertClaudeSubagentNotification, assertLifecycleEvidence, assertSingleLifecycleEvidence } from "../scripts/lifecycle-sim/evidence";

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
  expect(() => assertLifecycleEvidence(
    ["request", "tool_call", "tool_result", "idle", "idle"],
    ["request", "tool_call", "tool_result", "idle"],
  )).toThrow("unexpected lifecycle phase");
});

test("single lifecycle evidence rejects duplicate steering delivery", () => {
  expect(() => assertSingleLifecycleEvidence(["steering_active", "steering"], "steering")).not.toThrow();
  expect(() => assertSingleLifecycleEvidence(["steering", "steering"], "steering"))
    .toThrow("expected exactly one lifecycle phase: steering");
});

test.each([false, true])("Claude launch acknowledgement is independent of child request scheduling: %s", ackFirst => {
  const prefix = ["request", "tool_call", "tool_result"];
  const launch = ackFirst ? ["subagent_launch_ack", "subagent_request"] : ["subagent_request", "subagent_launch_ack"];
  const suffix = ["subagent_result", "subagent_notification", "compact", "interrupt", "resume", "steering_active", "steering", "idle"];
  const valid = [...prefix, ...launch, ...suffix];
  expect(() => assertClaudeLifecycleEvidence(valid)).not.toThrow();
  for (const phase of valid) {
    expect(() => assertClaudeLifecycleEvidence(valid.filter(item => item !== phase))).toThrow();
    expect(() => assertClaudeLifecycleEvidence([...valid, phase])).toThrow();
  }
  expect(() => assertClaudeLifecycleEvidence(["subagent_launch_ack", ...prefix, "subagent_request", ...suffix])).toThrow();
  expect(() => assertClaudeLifecycleEvidence([...prefix, "subagent_request", ...suffix, "subagent_launch_ack"])).toThrow();
  expect(() => assertClaudeLifecycleEvidence([...prefix, "subagent_result", ...launch, ...suffix.slice(1)])).toThrow();
});

test("Claude completion binds unique fields inside one notification", () => {
  const result = "<result>CLAUDE_LIFECYCLE_CHILD_DONE</result>";
  const valid = `<task-notification><task-id>agent-1</task-id><tool-use-id>toolu_lifecycle_agent</tool-use-id><status>completed</status>${result}</task-notification>`;
  expect(() => assertClaudeSubagentNotification(`<system-reminder>${valid}</system-reminder>`, "agent-1")).not.toThrow();
  for (const field of ["task-id", "tool-use-id", "status", "result"]) {
    for (const extra of [`<${field}>extra</${field}>`, `<${field} ignored="true">extra</${field}>`, `<${field}>`]) {
      expect(() => assertClaudeSubagentNotification(valid + extra, "agent-1")).toThrow();
      expect(() => assertClaudeSubagentNotification(extra + valid, "agent-1")).toThrow();
    }
  }
  for (const invalid of [
    valid.replace(result, "<result>WRONG</result>") + valid.replace("agent-1", "other-agent"),
    valid + valid,
    valid.replace(result, result + result),
    valid.replace("<status>completed</status>", "<status>failed</status><status>completed</status>"),
    valid.replace("<task-id>agent-1</task-id>", "<task-id>agent-1</task-id><task-id>other-agent</task-id>"),
    valid.replace(result, "") + result,
    valid.replace("agent-1", "other-agent"),
    valid.replace("toolu_lifecycle_agent", "wrong-call"),
    valid.replace("completed", "failed"),
  ]) expect(() => assertClaudeSubagentNotification(invalid, "agent-1")).toThrow();
  expect(() => assertClaudeSubagentNotification(valid, undefined)).toThrow();
});
