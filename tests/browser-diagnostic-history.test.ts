import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BrowserDiagnosticHistory, pruneBrowserDiagnosticHistory } from "../src/adapters/chatgpt-web/browser-diagnostic-history";

const baseTime = Date.now() / 1000 - 2 * 24 * 60 * 60;

function fixture(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "cgw-diagnostic-history-"));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function trace(root: string, name: string, time: number, status?: "active" | "failed" | "completed", pid = process.pid) {
  const directory = join(root, name);
  mkdirSync(directory);
  writeFileSync(join(directory, "01-composer-ready.json"), "{}");
  if (status) writeFileSync(join(directory, ".trace-state"), JSON.stringify({ status, pid }));
  utimesSync(directory, baseTime + time, baseTime + time);
  return directory;
}

test("a retry burst keeps more than ten recent failures while rotating successful captures", () => fixture(root => {
  for (let i = 0; i < 14; i++) trace(root, `failure-${i}`, 100 + i, "failed");
  for (let i = 0; i < 30; i++) trace(root, `success-${i}`, 200 + i, "completed");
  pruneBrowserDiagnosticHistory(root);
  expect(readdirSync(root).sort()).toEqual([
    ...Array.from({ length: 14 }, (_, i) => `failure-${i}`),
    ...Array.from({ length: 10 }, (_, i) => `success-${i + 20}`),
  ].sort());
}));

test("cleanup preserves running captures even when many newer requests finish", () => fixture(root => {
  const active = trace(root, "active-very-old", 1, "active");
  for (let i = 0; i < 25; i++) trace(root, `success-${i}`, 200 + i, "completed");
  pruneBrowserDiagnosticHistory(root);
  expect(existsSync(join(active, "01-composer-ready.json"))).toBe(true);
  expect(readdirSync(root)).toHaveLength(11);
  const history = new BrowserDiagnosticHistory(root, join(root, "new-trace"));
  history.start();
  history.finish("completed");
  expect(existsSync(active)).toBe(true);
  expect(JSON.parse(readFileSync(join(root, "new-trace", ".trace-state"), "utf8"))).toEqual({ status: "completed", pid: process.pid });
  expect(readdirSync(root)).toHaveLength(11);
}));

test("a crashed capture uses the failed-capture retention policy", () => fixture(root => {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  expect(child.status).toBe(0);
  expect(() => process.kill(child.pid, 0)).toThrow();
  for (let i = 0; i < 14; i++) trace(root, `interrupted-${i}`, 100 + i, "active", child.pid);
  for (let i = 0; i < 20; i++) trace(root, `success-${i}`, 200 + i, "completed");
  pruneBrowserDiagnosticHistory(root);
  expect(readdirSync(root)).toHaveLength(24);
  expect(existsSync(join(root, "interrupted-13"))).toBe(true);
  expect(existsSync(join(root, "interrupted-0"))).toBe(true);
}));

test("already captured failures survive cleanup and symlinks are never followed", () => fixture(root => {
  const failed = trace(root, "existing-failure", 100);
  writeFileSync(join(failed, "24-turn-failed.json"), "{}");
  utimesSync(failed, baseTime + 100, baseTime + 100);
  const verification = trace(root, "existing-verification", 101);
  writeFileSync(join(verification, "04-connector-verification-failed.json"), "{}");
  utimesSync(verification, baseTime + 101, baseTime + 101);
  const external = mkdtempSync(join(tmpdir(), "cgw-diagnostic-external-"));
  try {
    writeFileSync(join(external, "untouched"), "keep");
    symlinkSync(external, join(root, "linked-directory"), "junction");
    for (let i = 0; i < 20; i++) trace(root, `success-${i}`, 200 + i, "completed");
    pruneBrowserDiagnosticHistory(root);
    expect(existsSync(failed)).toBe(true);
    expect(existsSync(verification)).toBe(true);
    expect(readFileSync(join(external, "untouched"), "utf8")).toBe("keep");
    expect(existsSync(join(root, "linked-directory"))).toBe(true);
  } finally { rmSync(external, { recursive: true, force: true }); }
}));

test("finishing without a capture creates no empty diagnostic history", () => fixture(root => {
  const history = new BrowserDiagnosticHistory(root, join(root, "unused-trace"));
  history.finish("failed");
  expect(readdirSync(root)).toEqual([]);
  history.start();
  history.finish("failed");
  expect(JSON.parse(readFileSync(join(root, "unused-trace", ".trace-state"), "utf8"))).toEqual({ status: "failed", pid: process.pid });
}));

test("failed captures expire after three days but live captures are never deleted", () => fixture(root => {
  const expired = trace(root, "expired-failure", -2 * 24 * 60 * 60, "failed");
  const recent = trace(root, "recent-failure", 0, "failed");
  const active = trace(root, "active-old-capture", -2 * 24 * 60 * 60, "active");
  pruneBrowserDiagnosticHistory(root);
  expect(existsSync(expired)).toBeFalse();
  expect(existsSync(recent)).toBeTrue();
  expect(existsSync(active)).toBeTrue();
}));

test("the 100 MB finished-capture budget keeps newer failures before older failures or successes", () => fixture(root => {
  const older = trace(root, "older-failure", 100, "failed");
  const newer = trace(root, "newer-failure", 200, "failed");
  const success = trace(root, "newest-success", 300, "completed");
  for (const directory of [older, newer, success]) {
    const path = join(directory, "capture.png");
    writeFileSync(path, "");
    truncateSync(path, 60 * 1024 * 1024);
  }
  for (const [directory, time] of [[older, 100], [newer, 200], [success, 300]] as const) {
    utimesSync(directory, baseTime + time, baseTime + time);
  }
  pruneBrowserDiagnosticHistory(root);
  expect(existsSync(newer)).toBeTrue();
  expect(existsSync(older)).toBeFalse();
  expect(existsSync(success)).toBeFalse();
}));
