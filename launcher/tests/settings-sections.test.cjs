const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const settingsPath = path.join(launcherRoot, "src", "settings-surface.tsx");
const settingsSource = fs.existsSync(settingsPath)
  ? fs.readFileSync(settingsPath, "utf8")
  : fs.readFileSync(path.join(launcherRoot, "src", "App.tsx"), "utf8");
const i18nSource = fs.readFileSync(path.join(launcherRoot, "src", "i18n.ts"), "utf8");
const i18nJaSource = fs.readFileSync(path.join(launcherRoot, "src", "i18n-ja.ts"), "utf8");

test("settings keep upstream controls in General and fork controls in Enhanced Feature Settings", () => {
  const general = settingsSource.indexOf("<SectionHeading label={copy.general}");
  const enhanced = settingsSource.indexOf("<SectionHeading label={copy.enhancedFeatureSettings}");
  const diagnostics = settingsSource.indexOf("<SectionHeading label={copy.diagnostics}");

  assert.ok(enhanced >= 0, "Enhanced settings section must exist");
  assert.ok(general > enhanced, "General settings must follow Enhanced settings");
  assert.ok(diagnostics > general, "Diagnostics must follow General settings");

  const enhancedSource = settingsSource.slice(enhanced, general);
  const generalSource = settingsSource.slice(general, diagnostics);
  for (const key of ["launchAtLogin", "interactionMode", "keepRunningOnClose", "showDuringTurns", "biggerContext", "language"]) {
    assert.match(generalSource, new RegExp(`copy\\.${key}`));
  }
  for (const key of ["bridgeRoute", "enhancedWebSessionMode", "noAutoCompact", "zeroRiskModelSettings", "lockBrowserDuringTurns"]) {
    assert.match(enhancedSource, new RegExp(`copy\\.${key}`));
  }
});

test("No Context Window remains explicitly experimental in every launcher locale", () => {
  assert.match(i18nSource, /No Context Window \(experimental\)/);
  assert.match(i18nSource, /No Context Window（实验性）/);
  assert.match(i18nJaSource, /No Context Window（試験的）/);
});
