import { expect, test } from "bun:test";
import { defaultConfig, type AppConfig } from "../src/config";
import { buildSetupConfig } from "../src/setup-config";

test("Automatic to Zero Risk to Automatic setup preserves the Automatic connector identity", () => {
  const original: AppConfig = {
    ...defaultConfig("full"),
    appName: "Codex Native2",
    automaticAppName: "Codex Native2",
    manualAppName: "Codex Zero Risk",
    browserHost: "launcher",
    acknowledgedUnofficialAt: new Date(0).toISOString(),
  };
  const manual = buildSetupConfig(original, {
    mode: "full", browserInteractionMode: "manual", appName: "Codex Zero Risk",
  });
  expect(manual.appName).toBe("Codex Zero Risk");
  expect(manual.automaticAppName).toBe("Codex Native2");
  const restored = buildSetupConfig(manual, { mode: "full", browserInteractionMode: "automatic" });
  expect(restored.appName).toBe("Codex Native2");
  expect(restored.manualAppName).toBe("Codex Zero Risk");
});
