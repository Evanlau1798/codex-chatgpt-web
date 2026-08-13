import { describe, expect, test } from "bun:test";
import { withStallTimeout } from "../src/stall-timeout";
import { ChatGptTraceFeed } from "../src/adapters/chatgpt-web/turn-execution";

describe("withStallTimeout", () => {
  test("rejects work that makes no progress", async () => {
    const pending = new Promise<never>(() => {});

    await expect(withStallTimeout(pending, 10)).rejects.toThrow(
      "Upstream made no progress for 10ms",
    );
  });

  test("returns work completed before the deadline", async () => {
    await expect(withStallTimeout(Promise.resolve("done"), 10)).resolves.toBe("done");
  });
});

test("a DOM progress signal wakes the trace wait without emitting synthetic text", async () => {
  const trace = new ChatGptTraceFeed();
  const waiting = trace.wait();
  trace.signalProgress();
  await expect(withStallTimeout(waiting, 20)).resolves.toBeUndefined();
  expect(trace.drain()).toEqual([]);
});
