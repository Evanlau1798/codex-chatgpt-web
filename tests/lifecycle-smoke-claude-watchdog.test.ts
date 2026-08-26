import { expect, test } from "bun:test";
import {
  ClaudeResultWatchdog,
  claudeResultRecordSignalsProgress,
} from "../scripts/lifecycle-smoke/claude-watchdog";

test("Claude keepalives do not extend inactivity while semantic records do", () => {
  const watchdog = new ClaudeResultWatchdog(1_000, 20_000, 60_000);
  watchdog.observe(5_000, [
    { type: "stream_event", event: { type: "ping" } },
    { type: "system", subtype: "status" },
  ]);
  expect(watchdog.deadline()).toBe(21_000);
  watchdog.observe(10_000, [{ type: "assistant", message: { content: [] } }]);
  expect(watchdog.deadline()).toBe(30_000);
  expect(claudeResultRecordSignalsProgress({
    type: "stream_event",
    event: { type: "content_block_delta" },
  })).toBeTrue();
});

test("continuous Claude progress cannot move the absolute result ceiling", () => {
  const watchdog = new ClaudeResultWatchdog(1_000, 20_000, 60_000);
  for (const now of [10_000, 20_000, 30_000, 40_000, 50_000, 60_000]) {
    watchdog.observe(now, [{ type: "assistant" }]);
  }
  expect(watchdog.deadline()).toBe(61_000);
  expect(watchdog.expired(60_999)).toBeUndefined();
  expect(watchdog.expired(61_000)).toBe("absolute");
});

test("Claude inactivity expires before its absolute ceiling", () => {
  const watchdog = new ClaudeResultWatchdog(1_000, 20_000, 60_000);
  expect(watchdog.expired(20_999)).toBeUndefined();
  expect(watchdog.expired(21_000)).toBe("inactivity");
});
