import { expect, spyOn, test } from "bun:test";
import { chromium } from "playwright-core";
import * as launcherHost from "../src/launcher-browser-host";
import {
  waitForWebContractSurface,
  webContractCandidateSurfaceIds,
  inspectWebContractCanary,
  connectWebContractInspection,
} from "../scripts/lifecycle-smoke/web-contract-core";

test("canary inspection opts out of Playwright defaults and only queries native target metadata", async () => {
  const page = {};
  const commands: string[] = [];
  let closed = 0;
  const context = { pages: () => [page], newCDPSession: async () => ({
    send: async (method: string) => { commands.push(method); return { targetInfo: { targetId: "owned-target" } }; },
    detach: async () => {},
  }) };
  const browser = { contexts: () => [context], close: async () => { closed++; } };
  const descriptor = spyOn(launcherHost, "readLauncherBrowserHostDescriptor").mockReturnValue({
    endpoint: "http://127.0.0.1:9222", surfaceTargets: { canary: "owned-target" },
  } as never);
  const connect = spyOn(chromium, "connectOverCDP").mockResolvedValue(browser as never);
  try {
    const result = await connectWebContractInspection("descriptor.json", "canary", 5_000);
    expect<unknown>(connect.mock.calls[0]).toEqual([
      "http://127.0.0.1:9222", expect.objectContaining({ noDefaults: true }),
    ]);
    expect(result.page).toBe(page as never);
    expect(commands).toEqual(["Target.getTargetInfo"]);
    expect(closed).toBe(0);
    await result.browser.close();
    expect(closed).toBe(1);
  } finally { connect.mockRestore(); descriptor.mockRestore(); }
});

test("retained canary discovery includes a pre-existing standby then follows its proven surface", () => {
  const current = ["primary", "existing-turn", "canary-turn"];
  expect(webContractCandidateSurfaceIds("primary", current))
    .toEqual(["existing-turn", "canary-turn"]);
  expect(webContractCandidateSurfaceIds("primary", current, "canary-turn"))
    .toEqual(["canary-turn"]);
  expect(webContractCandidateSurfaceIds("primary", current, "missing-owner")).toEqual([]);
  expect(webContractCandidateSurfaceIds("primary", current, "primary")).toEqual([]);
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
  )).rejects.toThrow("expected one owned retained surface; found 2");
  expect(pauses).toBe(1);
});

test("retained canary discovery ignores a late standby and inspects actual ownership", async () => {
  let inspections = 0;
  const observed = await waitForWebContractSurface(
    () => ["stale-new", "canary-new"],
    async surfaceId => {
      inspections += 1;
      return surfaceId === "stale-new" ? undefined : { ownsCanary: true, userTurns: 1 };
    },
  );
  expect(observed).toEqual({ surfaceId: "canary-new", userTurns: 1 });
  expect(inspections).toBe(2);
});

test("canary DOM inspection rejects empty standby and foreign turns while preserving nested turn counting", async () => {
  const marker = "thread_web_contract_0123456789abcdef0123456789abcdef";
  const inspect = (text: string | undefined) => {
    const outer = { textContent: text ?? "", contains: (node: unknown) => node === inner };
    const inner = { textContent: text ?? "", contains: () => false };
    const nodes = text === undefined ? [] : [outer, inner];
    return inspectWebContractCanary({ evaluateAll: async (fn: any, arg: unknown) => fn(nodes, arg) } as never, marker);
  };
  expect(await inspect(undefined)).toEqual({ ownsCanary: false, userTurns: 0 });
  expect(await inspect("Canary ID: another_thread")).toEqual({ ownsCanary: false, userTurns: 0 });
  expect(await inspect(`context JSON with Canary ID: ${marker}`)).toEqual({ ownsCanary: true, userTurns: 1 });
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

test("standby inspection consumes the same absolute discovery budget", async () => {
  let now = 0;
  const budgets: number[] = [];
  const result = await waitForWebContractSurface(
    () => ["standby", "canary"],
    async (surfaceId, remainingMs) => {
      budgets.push(remainingMs);
      now += 1_000;
      return { ownsCanary: surfaceId === "canary", userTurns: surfaceId === "canary" ? 1 : 0 };
    },
    { timeoutMs: 5_000, now: () => now, pause: async () => {} },
  );
  expect(result).toEqual({ surfaceId: "canary", userTurns: 1 });
  expect(budgets).toEqual([5_000, 4_000]);
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
