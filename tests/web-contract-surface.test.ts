import { expect, test } from "bun:test";
import {
  waitForWebContractSurface,
  webContractCandidateSurfaceIds,
} from "../scripts/lifecycle-smoke/web-contract-core";

test("retained canary discovery isolates the fresh turn then follows its known surface", () => {
  const initial = new Set(["primary", "existing-turn"]);
  const current = ["primary", "existing-turn", "canary-turn"];
  expect(webContractCandidateSurfaceIds("primary", current, initial))
    .toEqual(["canary-turn"]);
  expect(webContractCandidateSurfaceIds("primary", current, initial, "canary-turn"))
    .toEqual(["canary-turn"]);
});

test("retained canary discovery waits for delayed projection without retrying duplicates", async () => {
  let observations = 0;
  let pauses = 0;
  const result = await waitForWebContractSurface(
    () => ["canary"],
    async () => ({ ownsCanary: ++observations > 1, userTurns: 1 }),
    { pause: async () => { pauses += 1; } },
  );
  expect(result).toEqual({ surfaceId: "canary", userTurns: 1 });
  expect({ observations, pauses }).toEqual({ observations: 2, pauses: 1 });
  await expect(waitForWebContractSurface(
    () => ["first", "second"],
    async () => ({ ownsCanary: true, userTurns: 1 }),
    { pause: async () => { pauses += 1; } },
  )).rejects.toThrow("expected one retained surface candidate; found 2");
  expect(pauses).toBe(1);
});

test("retained canary discovery rejects ambiguous candidates before inspection", async () => {
  let inspections = 0;
  await expect(waitForWebContractSurface(
    () => ["stale-new", "canary-new"],
    async surfaceId => {
      inspections += 1;
      return surfaceId === "stale-new" ? undefined : { ownsCanary: true, userTurns: 1 };
    },
  )).rejects.toThrow("expected one retained surface candidate; found 2");
  expect(inspections).toBe(0);
});

test("retained canary discovery preserves inspection failures", async () => {
  const failure = new Error("CDP inspection failed");
  let pauses = 0;
  await expect(waitForWebContractSurface(
    () => ["canary"],
    async () => { throw failure; },
    { pause: async () => { pauses += 1; } },
  )).rejects.toBe(failure);
  expect(pauses).toBe(0);
});

test("retained canary discovery passes a decreasing absolute deadline to inspection", async () => {
  let now = 1_000;
  const budgets: number[] = [];
  await expect(waitForWebContractSurface(
    () => ["canary"],
    async (_surfaceId, remainingMs) => {
      budgets.push(remainingMs);
      now += remainingMs;
      return { ownsCanary: false, userTurns: 1 };
    },
    { timeoutMs: 5_000, now: () => now, pause: async delay => { now += delay; } },
  )).rejects.toThrow("retained surface discovery deadline exceeded");
  expect(budgets).toEqual([5_000]);
});

test("retained canary discovery rejects an owner returned after the absolute deadline", async () => {
  let now = 0;
  await expect(waitForWebContractSurface(
    () => ["owner"],
    async () => {
      now = 5_001;
      return { ownsCanary: true, userTurns: 1 };
    },
    { timeoutMs: 5_000, now: () => now, pause: async () => {} },
  )).rejects.toThrow("retained surface discovery deadline exceeded");
});

test("retained canary discovery bounds a stalled inspection", async () => {
  let aborted = false;
  await expect(waitForWebContractSurface(
    () => ["owner"],
    async (_surfaceId, _remainingMs, signal) => await new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
    { timeoutMs: 5 },
  )).rejects.toThrow("retained surface discovery deadline exceeded");
  expect(aborted).toBeTrue();
});
