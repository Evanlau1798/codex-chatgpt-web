import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  claudeLifecycleTests,
  codexLifecycleTests,
  sharedLifecycleTests,
} from "../scripts/lifecycle-sim/manifest";

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

test("CI exposes one fail-closed aggregate gate for branch protection", () => {
  const workflow = readFileSync(resolve(repo, ".github", "workflows", "ci.yml"), "utf8");
  expect(workflow).toMatch(/ci-gate:\s+if: \$\{\{ always\(\) \}\}/);
  expect(workflow).toContain("needs: [lifecycle-sim, lifecycle-client-probe, verify, actionlint]");
  for (const dependency of ["lifecycle-sim", "lifecycle-client-probe", "verify", "actionlint"]) {
    expect(workflow).toContain(`needs['${dependency}'].result`);
  }
  expect(workflow).toContain('test "$LIFECYCLE_SIM_RESULT" = "success"');
});

test("CI verify fetches the ancestry required by the upstream audit ledger", () => {
  const workflow = readFileSync(resolve(repo, ".github", "workflows", "ci.yml"), "utf8");
  const verify = workflow.match(/\r?\n  verify:\r?\n([\s\S]*?)\r?\n  actionlint:/)?.[1];
  expect(verify).toContain("fetch-depth: 0");
});

test("the executable manifest owns every deterministic lifecycle test", () => {
  expect(codexLifecycleTests).toContain("tests/native-steering-boundary.test.ts");
  expect(claudeLifecycleTests).toContain("tests/claude-session-abort.test.ts");
  expect(sharedLifecycleTests).toContain("tests/lifecycle-race-ordering.test.ts");
  const registered = new Set<string>([...codexLifecycleTests, ...claudeLifecycleTests, ...sharedLifecycleTests]);
  const lifecycleSimTests = readdirSync(resolve(repo, "tests"))
    .filter(name => /^lifecycle-sim-.*\.test\.ts$/.test(name))
    .map(name => `tests/${name}`);
  expect(lifecycleSimTests.every(file => registered.has(file))).toBe(true);
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
  const build = workflow.match(/\r?\n  build:\r?\n([\s\S]*?)\r?\n  publish:/)?.[1];
  expect(workflow).toContain("lifecycle-gate:");
  expect(workflow).toContain("bun run lifecycle:sim --lane=all");
  expect(workflow).toContain("@openai/codex@0.150.1");
  expect(workflow).toContain("@anthropic-ai/claude-code@2.1.251");
  expect(workflow).toMatch(/build:\s+needs: lifecycle-gate/);
  expect(build).toContain("fetch-depth: 0");
});

test("latest-client canary runs both offline lanes and always reports safe status", () => {
  const workflow = readFileSync(resolve(repo, ".github", "workflows", "lifecycle-client-canary.yml"), "utf8");
  expect(workflow).toContain('cron: "17 3 * * 1"');
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).toMatch(/permissions:\s+contents: read/);
  expect(workflow).toContain("@openai/codex@latest");
  expect(workflow).toContain("@anthropic-ai/claude-code@latest");
  expect(workflow).toContain("timeout-minutes: 25");
  for (const [step, timeout] of [
    ["Install project dependencies", 3],
    ["Install latest lifecycle clients", 3],
    ["Run latest Codex deterministic lane", 5],
    ["Run latest Claude deterministic lane", 5],
  ] as const) {
    const block = workflow.slice(workflow.indexOf(step), workflow.indexOf("\n      - name:", workflow.indexOf(step) + 1));
    expect(block).toContain(`timeout-minutes: ${timeout}`);
  }
  expect(workflow).toContain("lifecycle:sim --lane=codex");
  expect(workflow).toContain("lifecycle:sim --lane=claude");
  expect(workflow.match(/if: \$\{\{ always\(\) \}\}/g)).toHaveLength(5);
  expect(workflow).toContain("actions/upload-artifact@v6");
  expect(workflow).toContain("CANARY_INSTALL_STATUS");
  const reportStep = workflow.slice(
    workflow.indexOf("Write privacy-safe canary report"),
    workflow.indexOf("Upload canary report"),
  );
  expect(reportStep).toContain("node -e");
  expect(reportStep).not.toContain("bun -e");
  expect(workflow).not.toMatch(/secret|smoke:lifecycle:web|smoke:lifecycle:deep/i);
});
