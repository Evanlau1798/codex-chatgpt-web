import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");

test("default lifecycle commands stay offline and deep live smoke remains explicit", () => {
  const pkg = JSON.parse(readFileSync(resolve(repo, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  expect(pkg.scripts["lifecycle:sim"]).toContain("scripts/lifecycle-sim/run.ts");
  expect(pkg.scripts["smoke:lifecycle:web"]).toContain("web-contract.ts");
  expect(pkg.scripts["smoke:lifecycle:deep"]).toContain("lifecycle-smoke/run.ts --live");
  expect(pkg.scripts["smoke:lifecycle"]).toBe("bun run lifecycle:sim --lane=all");
});

test("CI runs deterministic lifecycle simulation and never calls a live profile", () => {
  const workflow = readFileSync(resolve(repo, ".github", "workflows", "ci.yml"), "utf8");
  expect(workflow).toContain("bun run lifecycle:sim --lane=all");
  expect(workflow).not.toContain("smoke:lifecycle:web");
  expect(workflow).not.toContain("smoke:lifecycle:deep");
  expect(workflow).not.toContain("smoke:lifecycle:live");
});
