import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { listRootTestFiles } from "../scripts/run-root-tests";

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
