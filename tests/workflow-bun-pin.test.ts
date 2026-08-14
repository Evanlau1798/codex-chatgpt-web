import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("CI and release workflows install the pinned Bun canary", () => {
  const root = resolve(import.meta.dir, "..");
  const packageManager = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    packageManager: string;
  }).packageManager;
  const setupVersion = packageManager.match(/^bun@(\d+\.\d+\.\d+-canary\.\d+)\+/)?.[1];
  expect(setupVersion).toBe("1.4.0-canary.1");

  const workflows = [".github/workflows/ci.yml", ".github/workflows/release.yml"]
    .map(path => readFileSync(resolve(root, path), "utf8"))
    .join("\n");
  expect(workflows).not.toContain("bun-version: canary");
  expect(workflows.match(new RegExp(`bun-version: ${setupVersion}`, "g"))?.length).toBe(3);
});
