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
  assert.match(i18nSource, /import \{ ja \} from "\.\/i18n-ja"/);
  assert.match(read("launcher", "src", "i18n-ja.ts"), /export const ja: Record<keyof Copy, string> = \{/);
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

test("runtime health messages are localized without rewriting unknown failures", () => {
  assert.match(i18nSource, /export function localizeRuntimeMessage\(/);
  assert.match(i18nSource, /if \(language === "en"\) return message;/);
  assert.match(i18nSource, /return message;/);
  assert.match(appSource, /localizeRuntimeMessage\(copy, operation\.message, undefined, language\)/);
  assert.match(read("launcher", "src", "app-shared.tsx"), /localizeRuntimeMessage\(copy, check\.message, check\.id, language\)/);
  assert.match(read("launcher", "src", "settings-surface.tsx"), /<DoctorSummary copy=\{copy\} language=\{language\} report=\{doctor\}/);
});
