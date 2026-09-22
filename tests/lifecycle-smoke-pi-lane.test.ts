import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptAccountSafety } from "../src/adapters/chatgpt-web/account-safety";
import { closePiRpcRuns, openPiLiveSafety } from "../scripts/lifecycle-smoke/pi-lane";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function statePath(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-live-safety-"));
  roots.push(root);
  return join(root, "account-safety.json");
}

test("Pi live uses the persisted account safety budget and refuses an active pause", () => {
  const path = statePath();
  const account = new ChatGptAccountSafety(path);
  expect(account.admit("old", "old", 6, 300, []).allowed).toBe(true);
  const shared = openPiLiveSafety(path, 6, 300);
  expect(shared.status(6, 300, []).usedSessions).toBe(1);
  expect(shared.admit("pi", "pi", 6, 300, []).allowed).toBe(true);
  expect(new ChatGptAccountSafety(path).status(6, 300, []).usedSessions).toBe(2);
  account.trigger("account_security", []);
  expect(() => openPiLiveSafety(path, 6, 300)).toThrow();
});

test("daemon safety can reload Pi's persisted usage and hard stop before resuming", () => {
  const path = statePath();
  const daemon = new ChatGptAccountSafety(path);
  expect(daemon.admit("old", "old", 6, 300, []).allowed).toBe(true);
  const pi = openPiLiveSafety(path, 6, 300);
  expect(pi.admit("pi", "pi", 6, 300, []).allowed).toBe(true);
  daemon.reloadFromDisk();
  expect(daemon.status(6, 300, []).usedSessions).toBe(2);
  pi.trigger("account_security", []);
  daemon.reloadFromDisk();
  expect(daemon.admit("new", "new", 6, 300, []).allowed).toBe(false);
  expect(new ChatGptAccountSafety(path).status(6, 300, []).state).toBe("HARD_STOP");
});

test("Pi live refuses to consume a rolling budget without room for the tool and resume rounds", () => {
  const path = statePath();
  const account = new ChatGptAccountSafety(path);
  expect(account.admit("old", "old", 4, 300, []).allowed).toBe(true);
  expect(() => openPiLiveSafety(path, 4, 300)).toThrow();
});

test("Pi RPC cleanup attempts every process and fails when a reader reports an error", async () => {
  const closed: string[] = [];
  const runs = [
    { close: async () => { closed.push("first"); throw new Error("malformed frame"); } },
    { close: async () => { closed.push("second"); } },
  ];
  await expect(closePiRpcRuns(runs)).rejects.toThrow("Pi RPC cleanup failed");
  expect(closed).toEqual(["first", "second"]);
});
