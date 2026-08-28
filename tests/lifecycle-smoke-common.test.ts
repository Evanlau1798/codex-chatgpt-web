import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { auditPrompt, cleanupLifecycleResources, rootRequestCooldownRemaining, steeringAuditPassed } from "../scripts/lifecycle-smoke/common";

test("steering audit names the earlier steered guidance instead of its own user request", () => {
  expect(auditPrompt).toContain("Audit only the earlier lifecycle steering guidance containing marker ENGLISH_STEERING_VISIBLE");
  expect(auditPrompt).toContain("not this current audit request");
});

test("cleanup attempts every resource and fails the lane after any error", async () => {
  const calls: string[] = [];
  const action = (name: string, error?: Error) => async () => {
    calls.push(name);
    if (error) throw error;
  };

  await expect(cleanupLifecycleResources(
    [action("close-a", new Error("close failed")), action("close-b")],
    [action("cutoff-a", new Error("cutoff failed")), action("cutoff-b")],
  )).rejects.toThrow("Lifecycle smoke cleanup failed (2 errors)");
  expect(calls).toEqual(["close-a", "close-b", "cutoff-a", "cutoff-b"]);
});

test("root request cooldown waits only for the remaining one-minute budget", () => {
  expect(rootRequestCooldownRemaining(1_000, 60_000)).toBe(1_000);
  expect(rootRequestCooldownRemaining(1_000, 61_000)).toBe(0);
});

test("both live lanes anchor root cooldowns to request completion", () => {
  for (const file of ["codex-lane.ts", "claude-lane.ts"]) {
    const source = readFileSync(new URL(`../scripts/lifecycle-smoke/${file}`, import.meta.url), "utf8");
    expect(source).toContain("lastRootCompletionAt");
    expect(source).not.toContain("lastRootRequestAt");
  }
});

test("steering audit accepts natural stopping wording", () => {
  expect(steeringAuditPassed(`1. It appeared appended to a tool result.
2. I can see one literal occurrence.
3. It did not ask for repeated mention or stopping the original task.`)).toBe(true);
});

test("steering audit accepts an explicit none-of-those denial", () => {
  expect(steeringAuditPassed(`1. It appeared appended to a tool result.
2. One literal occurrence is visible.
3. None of those. The adjacent text said to continue the original task.`)).toBe(true);
});

test("steering audit accepts once as an exact literal count", () => {
  expect(steeringAuditPassed(`1. It appeared appended to a tool result.
2. The steering message appeared literally once.
3. The adjacent control text asked for none of those; it said to continue the original task.`)).toBe(true);
});

test("steering audit accepts acknowledgment and repetition nouns", () => {
  expect(steeringAuditPassed(`1. It appeared appended to a tool result.
2. One literal occurrence was present.
3. No; it asked for neither separate acknowledgment, repetition, nor stopping the original task.`)).toBe(true);
});
