import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, loadConfigForSetup, saveConfig } from "../src/config";

for (const custom of [false, true]) test(`legacy v3 configuration preserves Automatic connector identity: custom=${custom}`, () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-config-compat-"));
  const previous = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  try {
    const { browserInteractionMode: _mode, zeroRiskProEnabled: _pro,
      automaticAppName: _automatic, manualAppName: _manual, ...legacy } = defaultConfig();
    const appName = custom ? "TeamCodexHarness" : legacy.appName;
    writeFileSync(join(root, "config.json"), JSON.stringify({ ...legacy, appName }));
    for (const read of [loadConfig, loadConfigForSetup]) {
      expect(read()).toMatchObject({ browserInteractionMode: "automatic", zeroRiskProEnabled: false,
        appName, automaticAppName: appName, manualAppName: "Codex Zero Risk" });
    }
    saveConfig(loadConfig());
    expect(loadConfig().automaticAppName).toBe(appName);
  } finally {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("both configuration readers reject manual Full mode without a launcher host", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-config-host-"));
  const previous = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  try {
    writeFileSync(join(root, "config.json"), JSON.stringify({ ...defaultConfig("full"), browserInteractionMode: "manual" }));
    for (const read of [loadConfig, loadConfigForSetup]) expect(read).toThrow("requires the launcher browser host");
  } finally {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
