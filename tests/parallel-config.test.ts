import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { validateExperimentalFeatures } from "../src/config-feature-validation";
import { providerConfig } from "../src/provider-config";

test("parallel admission is opt-in and does not alter disabled/manual provider routing", () => {
  const config = defaultConfig("full");
  expect(providerConfig(config).chatgptWeb).not.toHaveProperty("experimentalParallelSubagents");
  expect(providerConfig({ ...config, experimentalParallelSubagents: true }).chatgptWeb?.experimentalParallelSubagents).toBeTrue();
  expect(providerConfig({ ...config, experimentalParallelSubagents: true, browserInteractionMode: "manual" }).chatgptWeb)
    .not.toHaveProperty("experimentalParallelSubagents");
});
test("parallel config preserves compaction reserve and validates feature types", () => {
  expect(() => validateExperimentalFeatures({ experimentalParallelSubagents: true, maxBrowserTabs: 3 }, "fixture")).toThrow("four browser slots");
  expect(() => validateExperimentalFeatures({ experimentalParallelSubagents: "yes" } as never, "fixture")).toThrow("Invalid experimentalParallelSubagents");
  expect(() => validateExperimentalFeatures({ experimentalParallelSubagents: true, maxBrowserTabs: 4 }, "fixture")).not.toThrow();
});
