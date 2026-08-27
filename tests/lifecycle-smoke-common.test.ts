import { expect, test } from "bun:test";
import { cleanupLifecycleResources } from "../scripts/lifecycle-smoke/common";

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
