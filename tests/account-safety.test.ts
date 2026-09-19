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
    const admission = manager.admit("trace-a", undefined, [], 1_000);
    expect(admission.allowed).toBe(true);
    expect(admission.status.windowStartedAt).toBeUndefined();
    expect(admission.steeringTraceIds).toEqual([]);
  } finally { cleanup(); }
});

test("duration expiry captures only active traces and steers each trace once", () => {
  const { manager, cleanup } = fixture();
  try {
    expect(manager.admit("trace-a", 5, [], 1_000).allowed).toBe(true);
    const expired = manager.admit("trace-new", 5, ["trace-a", "trace-b"], 301_001);
    expect(expired.allowed).toBe(false);
    expect(expired.status).toMatchObject({
      state: "DRAINING",
      reason: "duration_limit",
      windowStartedAt: 1_000,
      remainingMs: 0,
      capturedTraceIds: ["trace-a", "trace-b"],
    });
    expect(expired.steeringTraceIds).toEqual(["trace-a", "trace-b"]);
    manager.markSteeringQueued("trace-a");
    manager.markSteeringQueued("trace-b");

    const continuation = manager.admit("trace-a", 5, ["trace-a", "trace-b"], 301_010);
    expect(continuation.allowed).toBe(true);
    expect(continuation.steeringTraceIds).toEqual([]);
    expect(manager.admit("trace-c", 5, ["trace-a", "trace-b"], 301_020).allowed).toBe(false);
  } finally { cleanup(); }
});

test("duration expiry can proactively drain active traces without a new admission", () => {
  const { manager, cleanup } = fixture();
  try {
    expect(manager.admit("trace-a", 5, [], 1_000).allowed).toBe(true);
    expect(manager.tick(5, ["trace-a", "trace-b"], 300_999)).toEqual([]);
    expect(manager.tick(5, ["trace-a", "trace-b"], 301_000)).toEqual(["trace-a", "trace-b"]);
    expect(manager.status(5, ["trace-a", "trace-b"], 301_000)).toMatchObject({
      state: "DRAINING",
      reason: "duration_limit",
      capturedTraceIds: ["trace-a", "trace-b"],
      remainingMs: 0,
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
    expect(manager.status(undefined, ["trace-a", "trace-b", "trace-c"])).toMatchObject({
      state: "DRAINING",
      reason: "account_security",
      capturedTraceIds: ["trace-a", "trace-b", "trace-c"],
    });
    expect(manager.admit("trace-a", undefined, ["trace-a", "trace-b", "trace-c"]).allowed).toBe(true);
    manager.markSteeringQueued("trace-c");
    expect(manager.trigger("account_security", ["trace-a", "trace-b", "trace-c"])).toEqual([]);
    expect(manager.status(undefined, [])).toMatchObject({ state: "HARD_STOP", reason: "account_security" });
    expect(manager.admit("trace-new", undefined, []).allowed).toBe(false);
  } finally { cleanup(); }
});

test("account security drains active work before persisting a hard stop", () => {
  const { path, manager, cleanup } = fixture();
  try {
    expect(manager.admit("trace-a", 300, [], 10_000).allowed).toBe(true);
    expect(manager.trigger("account_security", ["trace-a"])).toEqual(["trace-a"]);
    expect(manager.status(300, ["trace-a"])).toMatchObject({
      state: "DRAINING",
      reason: "account_security",
      windowStartedAt: 10_000,
      capturedTraceIds: ["trace-a"],
    });
    expect(manager.admit("trace-a", 300, ["trace-a"]).allowed).toBe(true);
    manager.markSteeringQueued("trace-a");
    expect(manager.status(300, [])).toMatchObject({
      state: "HARD_STOP",
      reason: "account_security",
      windowStartedAt: 10_000,
      capturedTraceIds: [],
    });
    expect(() => manager.resume()).toThrow("requires acknowledgement");

    const restarted = new ChatGptAccountSafety(path);
    expect(restarted.status(300, ["trace-a"])).toMatchObject({
      state: "HARD_STOP",
      reason: "account_security",
      windowStartedAt: 10_000,
      capturedTraceIds: [],
    });
    expect(() => restarted.resume()).toThrow("requires acknowledgement");
    restarted.acknowledgeHardStop();
    expect(restarted.status(300, [])).toMatchObject({ state: "NORMAL" });
  } finally { cleanup(); }
});

test("pause recovery resets the local window while hard stop requires acknowledgement", () => {
  const { manager, cleanup } = fixture();
  try {
    manager.trigger("rate_limit", []);
    expect(manager.status(300, [])).toMatchObject({ state: "PAUSED", reason: "rate_limit" });
    manager.resume();
    expect(manager.status(300, [])).toMatchObject({ state: "NORMAL" });
    expect(manager.admit("trace-a", 300, [], 55_000).status.windowStartedAt).toBe(55_000);

    manager.trigger("account_security", []);
    expect(() => manager.resume()).toThrow("requires acknowledgement");
    manager.acknowledgeHardStop();
    expect(manager.status(300, [])).toMatchObject({ state: "NORMAL" });
    expect(manager.status(300, []).windowStartedAt).toBeUndefined();
  } finally { cleanup(); }
});

test("disabling the proactive duration limit clears its old window", () => {
  const { manager, cleanup } = fixture();
  try {
    expect(manager.admit("trace-a", 300, [], 10_000).status.windowStartedAt).toBe(10_000);
    expect(manager.status(undefined, [])).toMatchObject({ state: "NORMAL" });
    expect(manager.status(undefined, []).windowStartedAt).toBeUndefined();
    expect(manager.admit("trace-b", 300, [], 55_000).status.windowStartedAt).toBe(55_000);

    manager.trigger("rate_limit", []);
    expect(manager.status(undefined, [])).toMatchObject({ state: "PAUSED", reason: "rate_limit" });
  } finally { cleanup(); }
});

test("resume refuses a rate-limit drain in progress", () => {
  const rate = fixture();
  try {
    rate.manager.trigger("rate_limit", ["trace-a"]);
    expect(rate.manager.status(undefined, ["trace-a"])).toMatchObject({ state: "DRAINING", reason: "rate_limit" });
    expect(() => rate.manager.resume()).toThrow("draining");
    expect(rate.manager.status(undefined, ["trace-a"])).toMatchObject({ state: "DRAINING", reason: "rate_limit" });
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
    expect(manager.status(undefined, logical.activeTraceIds?.([]) ?? [])).toMatchObject({
      state: "DRAINING",
      reason: "rate_limit",
    });

    logical.releaseTrace?.("trace-a");
    expect(manager.status(undefined, logical.activeTraceIds?.([]) ?? [])).toMatchObject({
      state: "PAUSED",
      reason: "rate_limit",
    });
  } finally { cleanup(); }
});

test("persisted rate-limit draining state normalizes to pause after restart", () => {
  const { path, manager, cleanup } = fixture();
  try {
    manager.admit("trace-a", 300, [], 10_000);
    manager.trigger("rate_limit", ["trace-a"]);
    const restarted = new ChatGptAccountSafety(path);
    expect(restarted.status(300, [])).toMatchObject({
      state: "PAUSED",
      reason: "rate_limit",
      windowStartedAt: 10_000,
    });
  } finally { cleanup(); }
});

test("invalid persisted state fails closed until acknowledgement", () => {
  const { path, manager, cleanup } = fixture();
  try {
    manager.admit("trace-a", 300, [], 1_000);
    writeFileSync(path, "{}\n", "utf8");
    const reloaded = new ChatGptAccountSafety(path);
    expect(reloaded.status(undefined, [])).toMatchObject({ state: "HARD_STOP" });
    expect(() => reloaded.resume()).toThrow("requires acknowledgement");
    expect(readFileSync(path, "utf8")).toBe("{}\n");
    reloaded.acknowledgeHardStop();
    expect(reloaded.status(undefined, [])).toMatchObject({ state: "NORMAL" });
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
      manager.admit("trace-a", 300, [], 1_000);
      writeFileSync(path, `${JSON.stringify(persisted)}\n`, "utf8");
      const reloaded = new ChatGptAccountSafety(path);
      expect(reloaded.status(undefined, []), `case ${index}`).toMatchObject({ state: "HARD_STOP" });
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
