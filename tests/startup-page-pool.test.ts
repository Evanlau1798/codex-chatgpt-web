import { expect, test } from "bun:test";
import { ChatGptStartupPagePool } from "../src/adapters/chatgpt-web/startup-page-pool";

function page() {
  let releases = 0, pauses = 0;
  return { surfaceId: "s".repeat(32), prefix: "harness", pauseHeartbeat: () => { pauses++; },
    release: async () => { releases++; }, get releases() { return releases; }, get pauses() { return pauses; } };
}

test("capacity released by TTL is filled without another task, but disable and claim stop replenishment", async () => {
  const pool = new ChatGptStartupPagePool<ReturnType<typeof page>>();
  let available = false, attempts = 0;
  await pool.maintain("key", "harness", async () => {
    attempts++;
    if (!available) throw new Error("Startup preparation has no available account-safety capacity");
    return page();
  }, 5);
  available = true;
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(pool.take("key")).toBeDefined();
  const claimedAt = attempts;
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(attempts).toBe(claimedAt);
  await pool.maintain("key", "harness", async () => {
    attempts++; throw new Error("Startup preparation is disabled");
  }, 5);
  const disabledAt = attempts;
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(attempts).toBe(disabledAt);
  await pool.cancel();
});

test("TTL-retired standby ownership is replaced rather than counted as prepared", async () => {
  const pool = new ChatGptStartupPagePool<ReturnType<typeof page> & { isAvailable(): boolean }>();
  let valid = true, preparations = 0;
  await pool.maintain("key", "harness", async () => {
    preparations++;
    return { ...page(), isAvailable: () => valid };
  }, 5);
  valid = false;
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(preparations).toBeGreaterThan(1);
  expect(pool.take("key")).toBeUndefined();
  await pool.cancel();
});
test("one warm page is prepared once, claimed once and counted by its existing ownership", async () => {
  const pool = new ChatGptStartupPagePool<ReturnType<typeof page>>(), resource = page();
  let preparations = 0;
  const prepare = async () => { preparations++; return resource; };
  await pool.prime("same-model", "harness", prepare);
  await pool.prime("same-model", "harness", prepare);
  expect(preparations).toBe(1);
  expect(pool.take("same-model")).toBe(resource);
  expect(pool.take("same-model")).toBeUndefined();
  expect(resource.pauses).toBe(1);
  expect(resource.releases).toBe(0);
  await pool.cancel();
  expect(resource.releases).toBe(0);
});
test("changed model or harness cancels the old page before preparing the next", async () => {
  for (const change of ["model", "harness"]) {
    const pool = new ChatGptStartupPagePool<ReturnType<typeof page>>(), old = page(), next = page();
    await pool.prime("old", "harness", async () => old);
    await pool.prime(change === "model" ? "new" : "old", change === "model" ? "harness" : "new harness", async () => {
      expect(old.releases).toBe(1); return next;
    });
    expect(pool.take(change === "model" ? "new" : "old")).toBe(next);
    expect(old.releases).toBe(1);
  }
});
test("an unfinished preparation cannot be claimed and cancellation retires its late result", async () => {
  const pool = new ChatGptStartupPagePool<ReturnType<typeof page>>(), late = page();
  let finish!: (r: ReturnType<typeof page>) => void, signal: AbortSignal | undefined;
  const run = pool.prime("key", "harness", s => { signal = s; return new Promise(resolve => { finish = resolve; }); });
  await Promise.resolve();
  expect(pool.take("key")).toBeUndefined();
  const cancelled = pool.cancel();
  expect(signal?.aborted).toBeTrue();
  finish(late); await run; await cancelled;
  expect(late.releases).toBe(1);
  expect(pool.take("key")).toBeUndefined();
});
test("failed preparation leaves no claimable stale page", async () => {
  const pool = new ChatGptStartupPagePool<ReturnType<typeof page>>();
  await expect(pool.prime("key", "harness", async () => { throw new Error("failed"); })).rejects.toThrow("failed");
  expect(pool.take("key")).toBeUndefined();
  const next = page(); await pool.prime("key", "harness", async () => next);
  expect(pool.take("different-model")).toBeUndefined();
  expect(pool.take("key")).toBe(next);
});

test("late retired preparation cannot replace the latest harness or allocate another page early", async () => {
  const pool = new ChatGptStartupPagePool<ReturnType<typeof page>>(), old = page(), latest = page();
  let finish!: (r: ReturnType<typeof page>) => void;
  const initial = pool.prime("old", "old harness", () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  const allocated: string[] = [];
  const superseded = pool.prime("middle", "middle", async () => { allocated.push("middle"); return page(); });
  const final = pool.prime("latest", "latest", async () => {
    expect(old.releases).toBe(1); allocated.push("latest"); return latest;
  });
  expect(allocated).toEqual([]);
  finish(old);
  await Promise.all([initial, superseded, final]);
  expect(allocated).toEqual(["latest"]);
  expect(pool.take("old")).toBeUndefined();
  expect(pool.take("latest")).toBe(latest);
  expect(old.releases).toBe(1);
});

test("a failed ownership release prevents another speculative allocation", async () => {
  const pool = new ChatGptStartupPagePool<ReturnType<typeof page>>();
  await pool.prime("old", "harness", async () => ({ ...page(), release: async () => { throw new Error("not acknowledged"); } }));
  let allocated = false;
  await expect(pool.prime("next", "harness", async () => { allocated = true; return page(); }))
    .rejects.toThrow("not acknowledged");
  expect(allocated).toBeFalse();
  expect(pool.take("next")).toBeUndefined();
});

test("failed retirement retries its exact owner and unblocks only after a release acknowledgement", async () => {
  const pool = new ChatGptStartupPagePool<ReturnType<typeof page>>();
  let acknowledged = false, releases = 0, allocations = 0;
  await pool.prime("old", "harness", async () => ({ ...page(), release: async () => {
    releases++;
    if (!acknowledged) throw new Error("Launcher browser control end timed out after 15000ms");
  } }));
  const prepare = async () => { allocations++; return page(); };
  await expect(pool.prime("new", "harness", prepare)).rejects.toThrow("end timed out");
  await expect(pool.cancel()).rejects.toThrow("end timed out");
  expect(allocations).toBe(0);
  expect(releases).toBe(2);
  acknowledged = true;
  await pool.cancel();
  await pool.prime("new", "harness", prepare);
  expect(releases).toBe(3);
  expect(allocations).toBe(1);
  expect(pool.take("new")).toBeDefined();
});

test("a preparation that rejects before returning its resource retains its early cleanup owner", async () => {
  const pool = new ChatGptStartupPagePool<ReturnType<typeof page>>();
  let finish!: () => void, ready!: () => void, acknowledged = false, releases = 0, allocations = 0;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const initial = pool.prime("old", "harness", async (_signal, registerCleanup) => {
    registerCleanup?.(async () => { releases++; if (!acknowledged) throw new Error("end unacknowledged"); });
    ready(); await pending; throw new Error("preparation aborted before resource return");
  });
  await started;
  const cancel = pool.cancel(); finish(); await initial;
  await expect(cancel).rejects.toThrow("end unacknowledged");
  const prepare = async () => { allocations++; return page(); };
  await expect(pool.prime("new", "harness", prepare)).rejects.toThrow("end unacknowledged");
  expect(allocations).toBe(0); expect(releases).toBe(2);
  acknowledged = true;
  await pool.prime("new", "harness", prepare);
  expect(releases).toBe(3); expect(allocations).toBe(1);
  await pool.cancel();
});
