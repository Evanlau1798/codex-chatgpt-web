const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStateStore } = require("../electron/state.cjs");

for (const [name, saved, mode, pro] of [
  ["default", {}, "automatic", false],
  ["onboarded manual", { onboardingComplete: true, browserInteractionMode: "manual" }, "manual", false],
  ["configured Pro", { coreSetupComplete: true, browserInteractionMode: "manual", zeroRiskProEnabled: true }, "manual", true],
  ["invalid mode", { coreSetupComplete: true, browserInteractionMode: "invalid" }, "automatic", false],
  ["incomplete onboarding", { browserInteractionMode: "manual", zeroRiskProEnabled: true }, "automatic", false],
]) test(`interaction state migration: ${name}`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-state-compat-"));
  const file = path.join(root, "state.json");
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, ...saved }));
    const store = createStateStore(file);
    assert.equal(store.read().browserInteractionMode, mode);
    assert.equal(store.read().zeroRiskProEnabled, pro);
    store.update({ language: "en" });
    assert.equal(createStateStore(file).read().browserInteractionMode, mode);
    assert.equal(createStateStore(file).read().zeroRiskProEnabled, pro);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
