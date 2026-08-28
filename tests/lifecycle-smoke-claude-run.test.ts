import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LifecycleArtifactEncoder, LifecycleMemoryBudget } from "../scripts/lifecycle-smoke/artifacts";
import { ClaudeRun } from "../scripts/lifecycle-smoke/claude-lane";
import { claudeLaneSurfaceCountIsExact } from "../scripts/lifecycle-smoke/claude-evidence";
import { claudeManualCompactEvidence, manualCompactContinuityPassed } from "../scripts/lifecycle-smoke/retained-check";

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { force: true }); });

test("Claude close rejects protocol overflow arriving after a result chunk", async () => {
  const output = join(tmpdir(), `lifecycle-claude-run-${crypto.randomUUID()}.jsonl`);
  paths.push(output);
  const run = Object.create(ClaudeRun.prototype) as any;
  run.output = output;
  run.records = [];
  run.receivedAt = [];
  run.results = 0;
  run.buffer = "";
  run.waiters = new Set();
  run.outputEncoder = new LifecycleArtifactEncoder();
  run.memoryBudget = new LifecycleMemoryBudget({ maxLineBytes: 128, maxTotalBytes: 512 });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  run.process = {
    stdout: new ReadableStream({ start(value) { controller = value; } }),
    stdin: { end: () => {} },
    exited: Promise.resolve(0),
    killed: false,
    kill: () => {},
  };
  run.errorTask = Promise.resolve();
  run.outputTask = run.readOutput();

  controller.enqueue(new TextEncoder().encode(
    `${JSON.stringify({ type: "result", subtype: "success", result: "ok" })}\n`,
  ));
  expect((await run.waitResult(1, 100)).result).toBe("ok");
  controller.enqueue(new TextEncoder().encode(`${"x".repeat(200)}\n`));
  controller.close();
  await expect(run.close()).rejects.toThrow("line limit");
});

test("Claude lane surface accounting fails closed on an extra Web tab", () => {
  const expected = ["initial-root", "auto-root", "child", "final-root"].map((tabId, index) => ({
    at: `2026-01-01T00:00:0${index}.000Z`, event: "browser.tab_created",
    detail: { tabId, traceId: `trace-${index}` },
  }));
  const childReuse = { at: "2026-01-01T00:00:04.000Z", event: "browser.tab_reused", detail: { tabId: "child", traceId: "child-resume" } };

  expect(claudeLaneSurfaceCountIsExact([...expected, childReuse] as any, 0, "child")).toBeTrue();
  expect(claudeLaneSurfaceCountIsExact([...expected, childReuse, {
    at: "2026-01-01T00:00:06.000Z", event: "browser.tab_created", detail: { tabId: "extra", traceId: "extra" },
  }] as any, 0, "child")).toBeFalse();
  expect(claudeLaneSurfaceCountIsExact([...expected, childReuse, {
    at: "2026-01-01T00:00:06.000Z", event: "browser.tab_created", detail: { tabId: "recovery", traceId: "trace-auto" },
  }] as any, 1, "child")).toBeTrue();

  const freshContinuation = {
    at: "2026-01-01T00:00:00.500Z", event: "browser.tab_created",
    detail: { tabId: "long-root", traceId: "trace-long" },
  };
  expect(claudeLaneSurfaceCountIsExact(
    [...expected, freshContinuation, childReuse] as any, 0, "child", true,
  )).toBeTrue();
  expect(claudeLaneSurfaceCountIsExact(
    [...expected, freshContinuation, childReuse] as any, 0, "child", false,
  )).toBeFalse();
});

test("Claude manual compact accepts only retained or proved recovery continuity", () => {
  expect(manualCompactContinuityPassed(true, false, false)).toBeTrue();
  expect(manualCompactContinuityPassed(false, true, true)).toBeTrue();
  expect(manualCompactContinuityPassed(false, true, false)).toBeFalse();
  expect(manualCompactContinuityPassed(false, false, false)).toBeFalse();
});

test("Claude manual compact follows a replacement surface trace", () => {
  const previous = [{ event: "browser.tab_retained", detail: { tabId: "old-tab", traceId: "old-trace" } }];
  const compact = [
    { event: "browser.tab_created", detail: { tabId: "new-tab", traceId: "new-trace" } },
    { event: "browser.diagnostic", detail: { traceId: "new-trace", message: "surface recovery eligible=true" } },
  ];

  expect(claudeManualCompactEvidence(previous, compact, "old-trace", "old-tab")).toEqual({
    replacement: compact[0], recoveryTrace: "new-trace", recovered: true, retained: false,
  });
});
