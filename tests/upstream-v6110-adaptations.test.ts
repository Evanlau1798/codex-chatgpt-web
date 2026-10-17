import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { buildSetupConfig } from "../src/setup-config";

test("prediction preference is applied by the maintained setup owner and survives later updates", () => {
  const initial = defaultConfig();
  initial.acknowledgedUnofficialAt = new Date(0).toISOString();
  expect(initial.composerPredictionsEnabled).toBe(true);
  const disabled = buildSetupConfig(initial, { mode: initial.mode, composerPredictionsEnabled: false });
  expect(disabled.composerPredictionsEnabled).toBe(false);
  expect(buildSetupConfig(disabled, { mode: initial.mode }).composerPredictionsEnabled).toBe(false);
  expect(buildSetupConfig(disabled, { mode: initial.mode, composerPredictionsEnabled: true })
    .composerPredictionsEnabled).toBe(true);
});
