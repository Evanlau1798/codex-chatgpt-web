import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHATGPT_ACCOUNT_SAFETY_DRAIN_PROMPT,
  ChatGptAccountSafety,
} from "../src/adapters/chatgpt-web/account-safety";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "codex-account-safety-"));
  const path = join(dir, "runtime", "account-safety.json");
  return {
    path,
    manager: new ChatGptAccountSafety(path),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("disabled proactive limit leaves the usage window unopened", () => {
  const { manager, cleanup } = fixture();
  try {
    const admission = manager.admit("trace-a", "session-a", undefined, undefined, [], 1_000);
    expect(admission.allowed).toBe(true);
    expect(admission.status.windowStartedAt).toBeUndefined();
    expect(admission.steeringTraceIds).toEqual([]);
  } finally { cleanup(); }
});

test("session-window budget counts unique sessions and drains when the limit is exhausted", () => {
  const { manager, cleanup } = fixture();
  const budget = manager as unknown as {
    admit: (
      traceId: string,
      sessionId: string,
      limitCount: number | undefined,
      limitMinutes: number | undefined,
      activeTraceIds: readonly string[],
      now?: number,
    ) => ReturnType<ChatGptAccountSafety["admit"]>;
    tick: (
      limitCount: number | undefined,
      limitMinutes: number | undefined,
      activeTraceIds: readonly string[],
      now?: number,
    ) => string[];
  };
  try {
    const first = budget.admit("trace-a", "session-a", 2, 300, [], 1_000);
    expect(first.allowed).toBe(true);
    expect(first.status).toMatchObject({ usedSessions: 1, sessionLimit: 2 });

    const sameSession = budget.admit("trace-b", "session-a", 2, 300, ["trace-a"], 2_000);
    expect(sameSession.allowed).toBe(true);
    expect(sameSession.status).toMatchObject({ usedSessions: 1, sessionLimit: 2 });

    const second = budget.admit("trace-c", "session-b", 2, 300, ["trace-a", "trace-b"], 3_000);
    expect(second.allowed).toBe(true);
    expect(second.status).toMatchObject({ usedSessions: 2, sessionLimit: 2 });
    expect(budget.tick(2, 300, ["trace-a", "trace-b", "trace-c"], 3_001)).toEqual([
      "trace-a",
      "trace-b",
      "trace-c",
    ]);
  } finally { cleanup(); }
});

test("session-window budget resets usage when the configured time window expires", () => {
  const { manager, cleanup } = fixture();
  const budget = manager as unknown as {
    admit: (
      traceId: string,
      sessionId: string,
      limitCount: number | undefined,
      limitMinutes: number | undefined,
      activeTraceIds: readonly string[],
      now?: number,
    ) => ReturnType<ChatGptAccountSafety["admit"]>;
    status: (
      limitCount: number | undefined,
      limitMinutes: number | undefined,
      activeTraceIds: readonly string[],
      now?: number,
    ) => ReturnType<ChatGptAccountSafety["status"]>;
  };
  try {
    expect(budget.admit("trace-a", "session-a", 2, 60, [], 1_000).allowed).toBe(true);
    expect(budget.status(2, 60, [], 60_000).usedSessions).toBe(1);

    const reset = budget.admit("trace-b", "session-b", 2, 60, [], 3_601_001);
    expect(reset.allowed).toBe(true);
    expect(reset.status).toMatchObject({
      state: "NORMAL",
      usedSessions: 1,
      sessionLimit: 2,
      windowStartedAt: 3_601_001,
    });
  } finally { cleanup(); }
});

test("session-window budget retains newer sessions when the oldest session leaves the rolling window", () => {
  const { manager, cleanup } = fixture();
  try {
    expect(manager.admit("trace-a", "session-a", 3, 60, [], 1_000).allowed).toBe(true);
    expect(manager.admit("trace-b", "session-b", 3, 60, [], 1_801_000).allowed).toBe(true);

    const status = manager.status(3, 60, [], 3_601_001);
    expect(status).toMatchObject({
      state: "NORMAL",
      usedSessions: 1,
      sessionLimit: 3,
      windowStartedAt: 1_801_000,
      remainingMs: 1_799_999,
    });

    const next = manager.admit("trace-c", "session-c", 3, 60, [], 3_601_002);
    expect(next.allowed).toBe(true);
    expect(next.status.usedSessions).toBe(2);
  } finally { cleanup(); }
});

test("session quota blocks new sessions while captured work can finish", () => {
  const { manager, cleanup } = fixture();
  try {
    expect(manager.admit("trace-a", "session-a", 2, 300, [], 1_000).allowed).toBe(true);
    const exhausted = manager.admit("trace-b", "session-b", 2, 300, ["trace-a"], 2_000);
    expect(exhausted.allowed).toBe(true);
    expect(exhausted.status).toMatchObject({
      state: "DRAINING",
      reason: "duration_limit",
      windowStartedAt: 1_000,
      usedSessions: 2,
      sessionLimit: 2,
      capturedTraceIds: ["trace-a", "trace-b"],
    });
    expect(exhausted.steeringTraceIds).toEqual(["trace-a", "trace-b"]);
    manager.markSteeringQueued("trace-a");
    manager.markSteeringQueued("trace-b");

    const continuation = manager.admit("trace-a", "session-a", 2, 300, ["trace-a", "trace-b"], 2_010);
    expect(continuation.allowed).toBe(true);
    expect(continuation.steeringTraceIds).toEqual([]);
    expect(manager.admit("trace-c", "session-c", 2, 300, ["trace-a", "trace-b"], 2_020).allowed).toBe(false);
  } finally { cleanup(); }
});

test("time-window expiry resets usage instead of draining active traces", () => {
  const { manager, cleanup } = fixture();
  try {
    expect(manager.admit("trace-a", "session-a", 3, 5, [], 1_000).allowed).toBe(true);
    expect(manager.tick(3, 5, ["trace-a"], 301_001)).toEqual([]);
    expect(manager.status(3, 5, ["trace-a"], 301_001)).toMatchObject({
      state: "NORMAL",
      usedSessions: 0,
      sessionLimit: 3,
    });
  } finally { cleanup(); }
});

test("account security upgrades an existing drain and preserves one steering per active trace", () => {
  const { manager, cleanup } = fixture();
  try {
    expect(manager.trigger("rate_limit", ["trace-a", "trace-b"])).toEqual(["trace-a", "trace-b"]);
    expect(manager.trigger("rate_limit", ["trace-a", "trace-b"])).toEqual(["trace-a", "trace-b"]);
    manager.markSteeringQueued("trace-a");
    manager.markSteeringQueued("trace-b");
    expect(manager.trigger("rate_limit", ["trace-a", "trace-b"])).toEqual([]);
    expect(manager.trigger("account_security", ["trace-a", "trace-b", "trace-c"])).toEqual(["trace-c"]);
    expect(manager.status(undefined, undefined, ["trace-a", "trace-b", "trace-c"])).toMatchObject({
      state: "DRAINING",
      reason: "account_security",
      capturedTraceIds: ["trace-a", "trace-b", "trace-c"],
    });
    expect(manager.admit("trace-a", "session-a", undefined, undefined, ["trace-a", "trace-b", "trace-c"]).allowed).toBe(true);
    manager.markSteeringQueued("trace-c");
    expect(manager.trigger("account_security", ["trace-a", "trace-b", "trace-c"])).toEqual([]);
    expect(manager.status(undefined, undefined, [])).toMatchObject({ state: "HARD_STOP", reason: "account_security" });
    expect(manager.admit("trace-new", "session-new", undefined, undefined, []).allowed).toBe(false);
  } finally { cleanup(); }
});

test("account security drains active work before persisting a hard stop", () => {
  const { path, manager, cleanup } = fixture();
  try {
    const now = Date.now();
    expect(manager.admit("trace-a", "session-a", 50, 300, [], now).allowed).toBe(true);
    expect(manager.trigger("account_security", ["trace-a"])).toEqual(["trace-a"]);
    expect(manager.status(50, 300, ["trace-a"], now + 1)).toMatchObject({
      state: "DRAINING",
      reason: "account_security",
      windowStartedAt: now,
      capturedTraceIds: ["trace-a"],
    });
    expect(manager.admit("trace-a", "session-a", 50, 300, ["trace-a"], now + 2).allowed).toBe(true);
    manager.markSteeringQueued("trace-a");
    expect(manager.status(50, 300, [], now + 3)).toMatchObject({
      state: "HARD_STOP",
      reason: "account_security",
      windowStartedAt: now,
      capturedTraceIds: [],
    });
    expect(() => manager.resume()).toThrow("requires acknowledgement");

    const restarted = new ChatGptAccountSafety(path);
    expect(restarted.status(50, 300, ["trace-a"], now + 4)).toMatchObject({
      state: "HARD_STOP",
      reason: "account_security",
      windowStartedAt: now,
      capturedTraceIds: [],
    });
    expect(() => restarted.resume()).toThrow("requires acknowledgement");
    restarted.acknowledgeHardStop();
    expect(restarted.status(50, 300, [])).toMatchObject({ state: "NORMAL" });
  } finally { cleanup(); }
});

test("pause recovery resets the local window while hard stop requires acknowledgement", () => {
  const { manager, cleanup } = fixture();
  try {
    manager.trigger("rate_limit", []);
    expect(manager.status(50, 300, [])).toMatchObject({ state: "PAUSED", reason: "rate_limit" });
    manager.resume();
    expect(manager.status(50, 300, [])).toMatchObject({ state: "NORMAL" });
    expect(manager.admit("trace-a", "session-a", 50, 300, [], 55_000).status.windowStartedAt).toBe(55_000);

    manager.trigger("account_security", []);
    expect(() => manager.resume()).toThrow("requires acknowledgement");
    manager.acknowledgeHardStop();
    expect(manager.status(50, 300, [])).toMatchObject({ state: "NORMAL" });
    expect(manager.status(50, 300, []).windowStartedAt).toBeUndefined();
  } finally { cleanup(); }
});

test("manual resume cannot clear an active rolling session-limit pause", () => {
  const { manager, cleanup } = fixture();
  try {
    expect(manager.admit("trace-a", "session-a", 2, 60, [], 1_000).allowed).toBe(true);
    expect(manager.admit("trace-b", "session-b", 2, 60, [], 2_000).allowed).toBe(true);
    expect(manager.status(2, 60, [], 2_001)).toMatchObject({
      state: "PAUSED",
      reason: "duration_limit",
      usedSessions: 2,
    });

    expect(() => manager.resume()).toThrow("rolling session limit");
    expect(manager.status(2, 60, [], 2_002)).toMatchObject({
      state: "PAUSED",
      reason: "duration_limit",
      usedSessions: 2,
    });
  } finally { cleanup(); }
});

test("disabling the proactive duration limit clears its old window", () => {
  const { manager, cleanup } = fixture();
  try {
    expect(manager.admit("trace-a", "session-a", 50, 300, [], 10_000).status.windowStartedAt).toBe(10_000);
    expect(manager.status(undefined, undefined, [])).toMatchObject({ state: "NORMAL" });
    expect(manager.status(undefined, undefined, []).windowStartedAt).toBeUndefined();
    expect(manager.admit("trace-b", "session-b", 50, 300, [], 55_000).status.windowStartedAt).toBe(55_000);

    manager.trigger("rate_limit", []);
    expect(manager.status(undefined, undefined, [])).toMatchObject({ state: "PAUSED", reason: "rate_limit" });
  } finally { cleanup(); }
});

test("resume refuses a rate-limit drain in progress", () => {
  const rate = fixture();
  try {
    rate.manager.trigger("rate_limit", ["trace-a"]);
    expect(rate.manager.status(undefined, undefined, ["trace-a"])).toMatchObject({ state: "DRAINING", reason: "rate_limit" });
    expect(() => rate.manager.resume()).toThrow("draining");
    expect(rate.manager.status(undefined, undefined, ["trace-a"])).toMatchObject({ state: "DRAINING", reason: "rate_limit" });
  } finally { rate.cleanup(); }
});

test("logical trace retention keeps a drain open across registry gaps", () => {
  const { manager, cleanup } = fixture();
  const logical = manager as ChatGptAccountSafety & {
    retainTrace?: (traceId: string) => void;
    releaseTrace?: (traceId: string) => void;
    activeTraceIds?: (traceIds: readonly string[]) => string[];
  };
  try {
    logical.retainTrace?.("trace-a");
    manager.trigger("rate_limit", ["trace-a"]);
    expect(manager.status(undefined, undefined, logical.activeTraceIds?.([]) ?? [])).toMatchObject({
      state: "DRAINING",
      reason: "rate_limit",
    });

    logical.releaseTrace?.("trace-a");
    expect(manager.status(undefined, undefined, logical.activeTraceIds?.([]) ?? [])).toMatchObject({
      state: "PAUSED",
      reason: "rate_limit",
    });
  } finally { cleanup(); }
});

test("persisted rate-limit draining state normalizes to pause after restart", () => {
  const { path, manager, cleanup } = fixture();
  try {
    const now = Date.now();
    manager.admit("trace-a", "session-a", 50, 300, [], now);
    manager.trigger("rate_limit", ["trace-a"]);
    const restarted = new ChatGptAccountSafety(path);
    expect(restarted.status(50, 300, [], now + 1)).toMatchObject({
      state: "PAUSED",
      reason: "rate_limit",
      windowStartedAt: now,
    });
  } finally { cleanup(); }
});

test("legacy fixed-window session state migrates into the rolling window", () => {
  const { path, manager, cleanup } = fixture();
  try {
    manager.admit("seed-trace", "seed-session", 3, 60, [], 500);
    writeFileSync(path, `${JSON.stringify({
      version: 1,
      state: "NORMAL",
      windowStartedAt: 1_000,
      sessionIds: ["session-a", "session-b"],
    })}\n`, "utf8");

    const restarted = new ChatGptAccountSafety(path);
    expect(restarted.status(3, 60, [], 2_000)).toMatchObject({
      state: "NORMAL",
      usedSessions: 2,
      windowStartedAt: 1_000,
    });
  } finally { cleanup(); }
});

test("invalid persisted state fails closed until acknowledgement", () => {
  const { path, manager, cleanup } = fixture();
  try {
    manager.admit("trace-a", "session-a", 50, 300, [], 1_000);
    writeFileSync(path, "{}\n", "utf8");
    const reloaded = new ChatGptAccountSafety(path);
    expect(reloaded.status(undefined, undefined, [])).toMatchObject({ state: "HARD_STOP" });
    expect(() => reloaded.resume()).toThrow("requires acknowledgement");
    expect(readFileSync(path, "utf8")).toBe("{}\n");
    reloaded.acknowledgeHardStop();
    expect(reloaded.status(undefined, undefined, [])).toMatchObject({ state: "NORMAL" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, state: "NORMAL" });
  } finally { cleanup(); }
});

test("parseable but inconsistent persisted state also fails closed", () => {
  const cases = [
    { version: 1, state: "NORMAL", reason: "account_security" },
    { version: 1, state: "PAUSED", reason: "account_security" },
    { version: 1, state: "HARD_STOP", reason: "rate_limit" },
    { version: 1, state: "DRAINING", reason: "rate_limit", capturedTraceIds: "trace-a", steeredTraceIds: [] },
    { version: 1, state: "DRAINING", reason: "rate_limit", capturedTraceIds: ["trace-a"], steeredTraceIds: ["trace-b"] },
    { version: 1, state: "NORMAL", windowStartedAt: "1000" },
  ] as const;

  for (const [index, persisted] of cases.entries()) {
    const { path, manager, cleanup } = fixture();
    try {
      manager.admit("trace-a", "session-a", 50, 300, [], 1_000);
      writeFileSync(path, `${JSON.stringify(persisted)}\n`, "utf8");
      const reloaded = new ChatGptAccountSafety(path);
      expect(reloaded.status(undefined, undefined, []), `case ${index}`).toMatchObject({ state: "HARD_STOP" });
      expect(() => reloaded.resume(), `case ${index}`).toThrow("requires acknowledgement");
    } finally { cleanup(); }
  }
});

test("drain prompt remains the exact bounded-finish instruction", () => {
  expect(CHATGPT_ACCOUNT_SAFETY_DRAIN_PROMPT).toBe(
    "The local Automatic Web safety budget has been reached. Do not start new work, spawn new agents, or expand scope. "
    + "Finish only the minimum steps needed to leave the current work in a consistent state, summarize completed work, "
    + "remaining work, and verification status, then end this turn.",
  );
});
