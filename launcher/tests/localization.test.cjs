const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const read = (...parts) => fs.readFileSync(path.join(repositoryRoot, ...parts), "utf8");

const appSource = read("launcher", "src", "App.tsx");
const i18nSource = read("launcher", "src", "i18n.ts");
const languageTypes = read("launcher", "src", "types.ts");
const electronMain = read("launcher", "electron", "main.cjs");
const stateSource = read("launcher", "electron", "state.cjs");

test("Japanese is a complete launcher language across state, IPC, onboarding, and Settings", () => {
  assert.match(languageTypes, /export type Language = "en" \| "zh-CN" \| "ja";/);
  assert.match(stateSource, /state\.language !== "ja"/);
  assert.match(electronMain, /value !== "ja"/);
  assert.match(i18nSource, /const ja: Record<keyof typeof en, string> = \{/);
  assert.match(i18nSource, /if \(language === "ja"\) return ja as Copy;/);
  assert.match(appSource, /active=\{selectedLanguage === "ja"\}/);
  assert.match(appSource, /onClick=\{\(\) => setSelectedLanguage\("ja"\)\}/);
  assert.match(appSource, /language === "ja" \? "ja-JP"/);
});

test("native launcher dialogs and tray actions follow persisted Japanese", () => {
  assert.match(electronMain, /ja: Object\.freeze\(\{[\s\S]*?openLauncher: "Codex Web GPT を開く"/);
  assert.match(electronMain, /updateTrayMenu\(state\.language\)/);
  assert.match(electronMain, /createTray\(logger, stateStore\.read\(\)\.language\)/);
});
