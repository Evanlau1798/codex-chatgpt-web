import { expect, test } from "bun:test";
import { cleanupLifecycleResources, rootRequestCooldownRemaining } from "../scripts/lifecycle-smoke/common";

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
