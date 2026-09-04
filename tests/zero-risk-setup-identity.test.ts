import { expect, test } from "bun:test";
import { defaultConfig, type AppConfig } from "../src/config";
import { buildSetupConfig } from "../src/setup-config";

test.each(["Codex Native2", "Team Codex Harness"])("Automatic to Zero Risk to Automatic setup preserves identity: %s", name => {
  const original: AppConfig = {
    ...defaultConfig("full"),
    appName: name,
    automaticAppName: name,
    manualAppName: "Codex Zero Risk",
    browserHost: "launcher",
    acknowledgedUnofficialAt: new Date(0).toISOString(),
  };
  const manual = buildSetupConfig(original, {
    mode: "full", browserInteractionMode: "manual", appName: "Codex Zero Risk",
  });
  expect(manual.appName).toBe("Codex Zero Risk");
  expect(manual.automaticAppName).toBe(name);
  const restored = buildSetupConfig(manual, { mode: "full", browserInteractionMode: "automatic" });
  expect(restored.appName).toBe(name);
  expect(restored.automaticAppName).toBe(name);
  expect(restored.browserInteractionMode).toBe("automatic");
  expect(restored.manualAppName).toBe("Codex Zero Risk");
});
