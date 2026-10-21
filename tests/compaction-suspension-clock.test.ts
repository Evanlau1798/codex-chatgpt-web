import { expect, test, spyOn } from "bun:test";
import { mock } from "node:test";
import { ChatGptSuspensionClock, remainingStageBudgetMs } from "../src/adapters/chatgpt-web/browser-stage-lifecycle";
import { withCompactionInactivity } from "../src/adapters/chatgpt-web/compaction-inactivity";
import { ChatGptTraceFeed } from "../src/adapters/chatgpt-web/turn-feeds";
import { deferred } from "../src/adapters/chatgpt-web/runtime-lifecycle";

test("compaction budgets observe a suspend gap before the next interval and still charge awake time", () => {
  let now = 0;
  const clock = new ChatGptSuspensionClock(1_000, 5_000, () => now);
  const started = clock.suspendedMs();
  now = 20_000;
  expect(clock.suspendedMs() - started).toBe(19_000);
  expect(remainingStageBudgetMs(5_000, now, clock.suspendedMs() - started)).toBe(4_000);
  for (let i = 0; i < 5; i++) { now += 1_000; clock.tick(now); }
  expect(remainingStageBudgetMs(5_000, now, clock.suspendedMs() - started)).toBe(0);
});

test.each([false, true])("Original compaction renews real progress only, heartbeat=%s", async heartbeat => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const clockNow = spyOn(performance, "now").mockImplementation(() => Date.now());
  const trace = new ChatGptTraceFeed();
  const browser = deferred<string>();
  let aborted = false;
  const run = withCompactionInactivity(browser.promise, trace, 40, () => { aborted = true; });
  void run.catch(() => {});
  try {
    mock.timers.tick(25);
    if (heartbeat) trace.signalProgress();
    else trace.recordProgress();
    mock.timers.tick(25);
    if (heartbeat) {
      await expect(run).rejects.toMatchObject({ code: "compaction_handoff_timeout", retryable: false });
      expect(aborted).toBeTrue();
    } else {
      expect(aborted).toBeFalse();
      browser.resolve("complete summary");
      expect(await run).toBe("complete summary");
    }
  } finally {
    browser.resolve("cleanup");
    await run.catch(() => {});
    clockNow.mockRestore();
    mock.timers.reset();
  }
});
