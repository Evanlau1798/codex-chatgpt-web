import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildClaudeSmokeSettings } from "../scripts/lifecycle-smoke/claude-config";
import { defaultConfig } from "../src/config";

test("retained Claude smoke settings never contain the live control token", () => {
  const config = { ...defaultConfig("browser-only"), controlToken: "LIVE_CONTROL_TOKEN" };
  const settings = buildClaudeSmokeSettings(config);

  expect(JSON.stringify(settings)).not.toContain(config.controlToken);
  expect(settings.env).not.toHaveProperty("CODEX_CHATGPT_WEB_CONTROL_TOKEN");
});

test("Claude live smoke selects Pro for settings and CLI invocations", () => {
  const source = readFileSync(new URL("../scripts/lifecycle-smoke/claude-lane.ts", import.meta.url), "utf8");
  expect(source).toContain('settings.model = "claude-chatgpt-web-pro"');
  expect(source).toContain('settings.availableModels.includes("claude-chatgpt-web-pro")');
  expect(source).toContain('"--model", "claude-chatgpt-web-pro", "--effort", "max"');
  expect(source).not.toContain('"xhigh"');
  expect(source).not.toContain('"claude-chatgpt-web-extra-high"');
});
