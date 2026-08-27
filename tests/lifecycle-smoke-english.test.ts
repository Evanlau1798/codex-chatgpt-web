import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { rootRequestCooldownMs, steeringText } from "../scripts/lifecycle-smoke/common";
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

test("the English steering marker continues instead of replacing the active task", () => {
  expect(steeringText).toContain("Respond only in English");
  expect(steeringText).toContain("continue the original task");
  expect(steeringText.toLowerCase()).not.toContain("acknowledge");
});

test("root lifecycle resumes use a one-minute cooldown", () => {
  expect(rootRequestCooldownMs).toBe(60_000);
});

test("the hierarchy interruption uses one blocking child wait without root busy polling", () => {
  expect(hierarchyPrompt).toContain("one blocking wait");
  expect(hierarchyPrompt).toContain("must not call send_input to address the root");
  expect(hierarchyPrompt).toContain("must not poll wait_agent");
});

test("hierarchy surface accounting accepts only the planned interrupt replacement", () => {
  selfTestHierarchySurfaceClassification();
});

test("targeted interrupt remains distinct from subtree close", () => {
  selfTestV2ActivityNormalization();
});
