import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { buildSetupConfig } from "../src/setup-config";

test("prediction preference defaults off and preserves explicit opt-in across setup", () => {
  const initial = defaultConfig();
  initial.acknowledgedUnofficialAt = new Date(0).toISOString();
  expect(initial.composerPredictionsEnabled).toBe(false);
  const disabled = buildSetupConfig(initial, { mode: initial.mode, composerPredictionsEnabled: false });
  expect(disabled.composerPredictionsEnabled).toBe(false);
  expect(buildSetupConfig(disabled, { mode: initial.mode }).composerPredictionsEnabled).toBe(false);
  expect(buildSetupConfig({ ...disabled, composerPredictionsEnabled: true }, { mode: initial.mode })
    .composerPredictionsEnabled).toBe(true);
  expect(buildSetupConfig(disabled, { mode: initial.mode, composerPredictionsEnabled: true })
    .composerPredictionsEnabled).toBe(true);
});
