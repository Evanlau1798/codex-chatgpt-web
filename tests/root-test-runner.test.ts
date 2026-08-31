import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { listRootTestFiles, rootTestEnvironment, shouldRetryBunCrash } from "../scripts/run-root-tests";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("root test discovery is sorted and excludes nested or non-TypeScript tests", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-root-tests-"));
  roots.push(root);
  writeFileSync(join(root, "zeta.test.ts"), "");
  writeFileSync(join(root, "alpha.test.ts"), "");
  writeFileSync(join(root, "ignored.test.js"), "");
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "nested", "nested.test.ts"), "");

  expect(listRootTestFiles(root).map(path => basename(path))).toEqual([
    "alpha.test.ts",
    "zeta.test.ts",
  ]);
});

test("root test isolation retries only bounded Bun runtime crashes", () => {
  expect(shouldRetryBunCrash(3, 1)).toBe(true);
  expect(shouldRetryBunCrash(3, 2)).toBe(true);
  expect(shouldRetryBunCrash(3, 3)).toBe(false);
  expect(shouldRetryBunCrash(1, 1)).toBe(false);
});

test("macOS root tests use a portable Unix socket root", () => {
  const environment = { TMPDIR: "/var/folders/long", KEEP: "yes" };
  expect(rootTestEnvironment("darwin", environment)).toEqual({ TMPDIR: "/tmp", KEEP: "yes" });
  expect(rootTestEnvironment("linux", environment)).toBe(environment);
});
