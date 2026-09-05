import { expect, spyOn, test } from "bun:test";
import { cancelStructuredCompactionTrace, existingStructuredCompactionRun, runStructuredCompactionOnce } from "../src/adapters/chatgpt-web/compaction-handoff";

test("failed compaction keeps its physical owner until cleanup settles", async () => {
  let release!: () => void;
  const physical = new Promise<void>(resolve => { release = resolve; });
  let retryStarted = false;
  const owner = { ownerKey: "v503-physical-owner", traceIds: [] };
  const first = runStructuredCompactionOnce("v503-first", owner, async (_signal, retain) => {
    retain?.(physical);
    throw new Error("deadline reached");
  });
  await expect(first).rejects.toThrow("deadline reached");
  const retry = runStructuredCompactionOnce("v503-retry", owner, async () => {
    retryStarted = true;
    return "checkpoint";
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(retryStarted).toBe(false);
  } finally {
    release();
    await retry;
  }
});

test("cancelling a queued owner cannot let its successor bypass earlier physical settlement", async () => {
  let release!: () => void;
  const physical = new Promise<void>(resolve => { release = resolve; });
  const ownerKey = "v503-owner-chain";
  const first = runStructuredCompactionOnce("v503-chain-a", { ownerKey, traceIds: [] }, async (_signal, retain) => {
    retain(physical);
    throw new Error("source failed");
  });
  await expect(first).rejects.toThrow("source failed");
  let secondStarted = false;
  const second = runStructuredCompactionOnce("v503-chain-b", { ownerKey, traceIds: ["chain-b"] }, async () => {
    secondStarted = true;
    return "unexpected";
  });
  const cancelled = cancelStructuredCompactionTrace("chain-b", new Error("queued owner cancelled"));
  await expect(second).rejects.toThrow("queued owner cancelled");
  let thirdStarted = false;
  const third = runStructuredCompactionOnce("v503-chain-c", { ownerKey, traceIds: [] }, async () => {
    thirdStarted = true;
    return "checkpoint";
  });
  const now = spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60_000);
  try {
    expect(existingStructuredCompactionRun("v503-chain-a")).toBe(first);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(secondStarted).toBe(false);
    expect(thirdStarted).toBe(false);
  } finally {
    now.mockRestore();
    release();
    await cancelled;
    await third;
  }
  expect(thirdStarted).toBe(true);
});
