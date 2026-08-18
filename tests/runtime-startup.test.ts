import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getClaudeSettingsPath, installClaudeIntegration } from "../src/claude-integration";
import { defaultConfig } from "../src/config";
import { reconcileRuntimeIntegrationCredentials } from "../src/runtime-startup";

const roots: string[] = [];

function fixture(): string {
  const root = join(tmpdir(), `codex-chatgpt-web-runtime-startup-${process.pid}-${Date.now()}-${Math.random()}`);
  const claudeHome = join(root, "claude");
  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(join(claudeHome, "settings.json"), `${JSON.stringify({
    language: "traditional-chinese",
    env: { KEEP: "user-value" },
  }, null, 2)}\n`);
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.CODEX_CHATGPT_WEB_HOME = join(root, "app");
  roots.push(root);
  return root;
}

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_CHATGPT_WEB_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("serve startup refreshes stale managed Claude steering credentials", () => {
  fixture();
  const installed = defaultConfig("full");
  installClaudeIntegration(installed);
  const restarted = { ...installed, controlToken: "r".repeat(43) };

  expect(reconcileRuntimeIntegrationCredentials(restarted)).toEqual({
    claudeCredentialsRefreshed: true,
  });

  const settings = JSON.parse(readFileSync(getClaudeSettingsPath(), "utf8"));
  expect(settings).toMatchObject({
    language: "traditional-chinese",
    env: {
      KEEP: "user-value",
      CODEX_CHATGPT_WEB_CONTROL_TOKEN: restarted.controlToken,
    },
  });
});
