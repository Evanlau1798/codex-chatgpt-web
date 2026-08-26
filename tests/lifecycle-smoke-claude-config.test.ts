import { expect, test } from "bun:test";
import { buildClaudeSmokeSettings } from "../scripts/lifecycle-smoke/claude-config";
import { defaultConfig } from "../src/config";

test("retained Claude smoke settings never contain the live control token", () => {
  const config = { ...defaultConfig("browser-only"), controlToken: "LIVE_CONTROL_TOKEN" };
  const settings = buildClaudeSmokeSettings(config);

  expect(JSON.stringify(settings)).not.toContain(config.controlToken);
  expect(settings.env).not.toHaveProperty("CODEX_CHATGPT_WEB_CONTROL_TOKEN");
});
