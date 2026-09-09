import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import {
  advancePreemptiveRetryStop,
  beginPreemptiveRetryStop,
} from "../src/adapters/chatgpt-web/preemptive-retry-stop";

test("direct browser checkpoint preemption is one-shot and scoped to an active turn", () => {
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "managed-chrome" },
    activeRuns: new Map([["active-trace", new Promise<string>(() => {})]]),
    preemptiveRetries: new Map<string, string>(),
    preemptedRuns: new Set<string>(),
  }) as ChatGptBrowserWorker;
  const take = (ChatGptBrowserWorker.prototype as unknown as {
    takePreemptiveRetry(traceId: string): string | undefined;
  }).takePreemptiveRetry;

  expect(worker.requestPreemptiveRetry("missing-trace", "checkpoint")).toBeFalse();
  expect(worker.requestPreemptiveRetry("active-trace", "checkpoint")).toBeTrue();
  expect(take.call(worker, "active-trace")).toBe("checkpoint");
  expect(take.call(worker, "active-trace")).toBeUndefined();
  expect(worker.requestPreemptiveRetry("active-trace", "checkpoint again")).toBeFalse();
});

test("active checkpoint preemption stops generation without taking the abort path", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const request = source.indexOf("const requestedPreemption =");
  const stop = source.indexOf('await stop.press("Enter")', request);
  const snapshot = source.indexOf("const snapshot = await this.responseDomSnapshot", request);
  const retry = source.indexOf("preemptiveRetryPrompt ?? await turn.retryPromptForAnswer", snapshot);
  const control = source.slice(request, retry);

  expect(request).toBeGreaterThan(-1);
  expect(stop).toBeGreaterThan(request);
  expect(snapshot).toBeGreaterThan(stop);
  expect(retry).toBeGreaterThan(snapshot);
  expect(control).toContain("CHATGPT_PREEMPTIVE_RETRY_STOP_TIMEOUT_MS");
  expect(control).toContain("chatgpt_compaction_preemption_failed");
  expect(control).not.toContain('throw new DOMException("ChatGPT web turn aborted"');
});

test("checkpoint preemption remains bounded when generation starts after the request is consumed", () => {
  const initial = beginPreemptiveRetryStop(1_000, 15_000);
  expect(advancePreemptiveRetryStop(initial, false, 1_000)).toEqual({
    state: initial,
    action: "proceed",
  });

  const started = advancePreemptiveRetryStop(initial, true, 2_000);
  expect(started.action).toBe("press_stop");
  expect(started.state.stopPressed).toBeTrue();
  expect(advancePreemptiveRetryStop(started.state, true, 15_999).action).toBe("wait");
  expect(advancePreemptiveRetryStop(started.state, true, 16_000).action).toBe("timed_out");
});

test("persistent helper preserves the control-only Native2 connector flag", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url), "utf8");

  expect(source).toContain("nativeConnector?: boolean;");
  expect(source).toContain("...(message.turn.nativeConnector ? { nativeConnector: true } : {}),");
});
