import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { auditPrompt, rootRequestCooldownMs, steeringText } from "../scripts/lifecycle-smoke/common";
import { hierarchyPrompt, selfTestHierarchySurfaceClassification } from "../scripts/lifecycle-smoke/codex-v2-scenario";
import { selfTestV2ActivityNormalization } from "../scripts/lifecycle-smoke/codex-v2-activity";

test("lifecycle smoke scripts contain no CJK prompt or validation text", () => {
  const root = join(import.meta.dir, "..", "scripts", "lifecycle-smoke");
  const offenders = readdirSync(root)
    .filter(name => name.endsWith(".ts"))
    .filter(name => /[\u3400-\u9fff]/u.test(readFileSync(join(root, name), "utf8")));

  expect(offenders).toEqual([]);
});

test("Claude TTL resume names and verifies the existing child identity", () => {
  const source = readFileSync(join(import.meta.dir, "..", "scripts", "lifecycle-smoke", "claude-lane.ts"), "utf8");

  expect(source).toContain("agent ID ${childId}");
  expect(source).toContain("resumedChildId === childId");
});

test("Claude child interaction verifies the requested final test name", () => {
  const source = readFileSync(join(import.meta.dir, "..", "scripts", "lifecycle-smoke", "claude-lane.ts"), "utf8");

  expect(source).toContain("finds Markdown restoration markers strictly right-to-left");
});

test("the English steering marker continues instead of replacing the active task", () => {
  expect(steeringText).toContain("Respond only in English");
  expect(steeringText).toContain("continue the original task");
  expect(steeringText.toLowerCase()).not.toContain("acknowledge");
});

test("the steering audit requires stable numbered answer labels", () => {
  expect(auditPrompt).toContain('Use exactly the labels "1." through "3."');
  expect(auditPrompt).toContain("Do not use blockquotes");
});

test("Claude audits steering inside the same active turn", () => {
  const source = readFileSync(join(import.meta.dir, "..", "scripts", "lifecycle-smoke", "claude-lane.ts"), "utf8");

  expect(source).toContain("`${steeringText}\\n\\n${auditPrompt}`");
  expect(source).not.toContain('new ClaudeRun(join(laneRoot, "steering-audit.jsonl")');
});

test("root lifecycle resumes use a one-minute cooldown", () => {
  expect(rootRequestCooldownMs).toBe(60_000);
});

test("the hierarchy root follows the transport-safe agent wait contract", () => {
  expect(hierarchyPrompt).toContain("one blocking read-only wait");
  expect(hierarchyPrompt).toContain("must not call send_input to address the root");
  expect(hierarchyPrompt).toContain("timeout_ms=10000");
  expect(hierarchyPrompt).toContain("repeat the same wait_agent call");
  expect(hierarchyPrompt).not.toContain("must not poll wait_agent");
  expect(hierarchyPrompt).toContain("complete before the child follow-up");
  expect(hierarchyPrompt).toContain("exactly six consecutive wait_agent calls");
  expect(hierarchyPrompt).toContain("Immediately after the sixth timeout");
  expect(hierarchyPrompt).toContain("interrupt=true exactly once");
  expect(hierarchyPrompt).toContain("close_agent exactly once");
  expect(hierarchyPrompt).toContain("completed grandchild");
});

test("hierarchy surface accounting accepts only the planned interrupt replacement", () => {
  selfTestHierarchySurfaceClassification();
});

test("targeted interrupt remains distinct from subtree close", () => {
  selfTestV2ActivityNormalization();
});
