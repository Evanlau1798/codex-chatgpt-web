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

test("contributor guidance defines the lifecycle profiles without untracked docs", () => {
  const contributing = readFileSync(resolve(repo, "CONTRIBUTING.md"), "utf8");
  const pullRequest = readFileSync(resolve(repo, ".github", "PULL_REQUEST_TEMPLATE.md"), "utf8");
  expect(contributing).not.toContain("docs/dev-chat.md");
  expect(contributing).not.toContain("docs/release-validation.md");
  expect(contributing).toContain("Compatibility V1 and native V2");
  expect(contributing).toContain("production-composed adapter");
  expect(contributing).toContain("`browserIdle`");
  expect(contributing).toContain("full daemon idle");
  expect(contributing).toContain("manual `deep` diagnostic");
  expect(pullRequest).toContain("CONTRIBUTING.md#lifecycle-verification-gate");
});

test("release builds rerun the deterministic lifecycle gate at the tag SHA", () => {
  const workflow = readFileSync(resolve(repo, ".github", "workflows", "release.yml"), "utf8");
  expect(workflow).toContain("lifecycle-gate:");
  expect(workflow).toContain("bun run lifecycle:sim --lane=all");
  expect(workflow).toContain("@openai/codex@0.150.1");
  expect(workflow).toContain("@anthropic-ai/claude-code@2.1.251");
  expect(workflow).toMatch(/build:\s+needs: lifecycle-gate/);
});
