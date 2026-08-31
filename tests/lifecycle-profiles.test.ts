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
  expect(workflow).toContain("lifecycle-client-probe:");
  expect(workflow).toContain("os: [macos-15, windows-latest]");
  expect(workflow).toContain("bun run scripts/smoke-codex-cancel.ts");
  expect(workflow).toContain("turn-broker-lifecycle.test.ts");
});

test("the all lane runs both lifecycle evidence oracle suites", () => {
  const runner = readFileSync(resolve(repo, "scripts", "lifecycle-sim", "run.ts"), "utf8");
  expect(runner).toContain("tests/lifecycle-sim-evidence.test.ts");
  expect(runner).toContain("tests/lifecycle-sim-codex-evidence.test.ts");
  expect(runner).toContain("tests/lifecycle-sim-production-composition.test.ts");
  expect(runner).toContain("tests/lifecycle-race-ordering.test.ts");
});

test("the Codex lane covers compatibility V1 and native V2 clients", () => {
  const runner = readFileSync(resolve(repo, "scripts", "lifecycle-sim", "run.ts"), "utf8");
  expect(runner).toContain('"--v1", codex');
  expect(runner).toContain('"--v2", codex');
});
