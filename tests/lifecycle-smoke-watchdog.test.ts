import { expect, test } from "bun:test";
import { CodexRun } from "../scripts/lifecycle-smoke/codex-app-server";
import { LifecycleProgressWatchdog } from "../scripts/lifecycle-smoke/progress-watchdog";

test("Codex protocol read failures reject active waits immediately", async () => {
  const run = Object.create(CodexRun.prototype) as any;
  let killed = false;
  run.process = { kill: () => { killed = true; } };
  run.pending = new Map();
  run.waiters = new Set();
  const pending = new Promise((resolve, reject) => run.pending.set(1, { resolve, reject }));
  const waiter = new Promise((resolve, reject) => run.waiters.add({ predicate: () => false, resolve, reject }));

  run.failRead(new Error("Codex RPC exceeded lifecycle memory limit"));

  await expect(pending).rejects.toThrow("memory limit");
  await expect(waiter).rejects.toThrow("memory limit");
  expect(killed).toBeTrue();
  expect(() => run.assertReadable()).toThrow("memory limit");
});

test("liveness records never extend semantic inactivity", () => {
  const watcher = new LifecycleProgressWatchdog({
    startedAt: 0,
    inactivityMs: 5_000,
    absoluteMs: 30_000,
    nativeToolLeaseMs: 2_000,
    nativeToolMaxMs: 10_000,
  });

  watcher.observe({ kind: "liveness" }, 4_000);
  expect(watcher.status(4_999)).toEqual({ timedOut: false });
  expect(watcher.status(5_000)).toEqual({ timedOut: true, reason: "semantic_inactivity" });
});

test("semantic progress extends inactivity without moving the absolute ceiling", () => {
  const watcher = new LifecycleProgressWatchdog({
    startedAt: 0,
    inactivityMs: 5_000,
    absoluteMs: 12_000,
    nativeToolLeaseMs: 2_000,
    nativeToolMaxMs: 10_000,
  });

  watcher.observe({ kind: "semantic_progress" }, 4_000);
  expect(watcher.status(8_999)).toEqual({ timedOut: false });
  expect(watcher.status(9_000)).toEqual({ timedOut: true, reason: "semantic_inactivity" });

  const absolute = new LifecycleProgressWatchdog({
    startedAt: 0,
    inactivityMs: 5_000,
    absoluteMs: 12_000,
    nativeToolLeaseMs: 2_000,
    nativeToolMaxMs: 10_000,
  });
  absolute.observe({ kind: "semantic_progress" }, 11_000);
  expect(absolute.status(12_000)).toEqual({ timedOut: true, reason: "absolute" });
});

test("native tool proof has a renewable lease but a non-renewable activity ceiling", () => {
  const watcher = new LifecycleProgressWatchdog({
    startedAt: 0,
    inactivityMs: 5_000,
    absoluteMs: 30_000,
    nativeToolLeaseMs: 4_000,
    nativeToolMaxMs: 12_000,
  });

  watcher.observe({ kind: "native_tool_proof", activity: "web_search" }, 4_000);
  expect(watcher.status(7_999)).toEqual({ timedOut: false });
  watcher.observe({ kind: "native_tool_proof", activity: "web_search" }, 7_000);
  expect(watcher.status(10_999)).toEqual({ timedOut: false });
  watcher.observe({ kind: "native_tool_proof", activity: "web_search" }, 10_000);
  watcher.observe({ kind: "native_tool_proof", activity: "web_search" }, 13_000);
  expect(watcher.status(15_999)).toEqual({ timedOut: false });
  expect(watcher.status(16_000)).toEqual({ timedOut: true, reason: "semantic_inactivity" });
});

test("inactive evidence ends one native tool window before another can begin", () => {
  const watcher = new LifecycleProgressWatchdog({
    startedAt: 0,
    inactivityMs: 5_000,
    absoluteMs: 40_000,
    nativeToolLeaseMs: 4_000,
    nativeToolMaxMs: 8_000,
  });

  watcher.observe({ kind: "native_tool_proof", activity: "native_tool" }, 3_000);
  watcher.observe({ kind: "native_tool_inactive" }, 6_000);
  watcher.observe({ kind: "native_tool_proof", activity: "native_tool" }, 7_000);
  watcher.observe({ kind: "native_tool_proof", activity: "native_tool" }, 12_000);
  expect(watcher.status(14_999)).toEqual({ timedOut: false });
  expect(watcher.status(15_000)).toEqual({ timedOut: true, reason: "semantic_inactivity" });
});
