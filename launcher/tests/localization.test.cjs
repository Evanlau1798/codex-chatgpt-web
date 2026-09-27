const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const read = (...parts) => fs.readFileSync(path.join(repositoryRoot, ...parts), "utf8");

const appSource = read("launcher", "src", "App.tsx");
const i18nSource = read("launcher", "src", "i18n.ts");
const languageTypes = read("launcher", "src", "types.ts");
const electronMain = read("launcher", "electron", "main.cjs");
const stateSource = read("launcher", "electron", "state.cjs");
const languages = JSON.parse(read("launcher", "electron", "languages.json"));
const loadI18nModule = () => {
  const modules = {};
  const load = file => {
    const exportsObject = {};
    new Function("exports", "require", ts.transpileModule(read("launcher", "src", file), {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText)(exportsObject, name => modules[name]);
    return exportsObject;
  };
  modules["./zero-risk-copy"] = load("zero-risk-copy.ts");
  modules["./i18n-ja"] = load("i18n-ja.ts");
  modules["./i18n-ko"] = load("i18n-ko.ts");
  modules["./i18n-zh-tw"] = load("i18n-zh-tw.ts");
  return load("i18n.ts");
};

test("every declared launcher language is wired across state, IPC, onboarding, and Settings", () => {
  assert.deepEqual(Object.keys(languages), ["en", "zh-CN", "zh-TW", "ja", "ko"]);
  assert.match(languageTypes, /import languages from "\.\.\/electron\/languages\.json";/);
  assert.match(languageTypes, /export type Language = keyof typeof languages;/);
  assert.match(stateSource, /Object\.hasOwn\(languages, state\.language\)/);
  assert.match(electronMain, /Object\.hasOwn\(languages, value\)/);
  assert.match(i18nSource, /import \{ ja \} from "\.\/i18n-ja"/);
  assert.match(i18nSource, /import \{ ko \} from "\.\/i18n-ko"/);
  assert.match(i18nSource, /import \{ zhTW \} from "\.\/i18n-zh-tw"/);
  assert.match(read("launcher", "src", "i18n-ja.ts"), /export const ja: Record<keyof Copy, string> = \{/);
  assert.match(i18nSource, /if \(language === "ja"\) return ja as Copy;/);
  assert.match(i18nSource, /if \(language === "zh-TW"\) return \{ \.\.\.en, \.\.\.zhTW \} as Copy;/);
  assert.match(i18nSource, /if \(language === "ko"\) return \{ \.\.\.en, \.\.\.ko \} as Copy;/);
  assert.match(appSource, /Object\.keys\(languages\) as Language\[\]/);
  assert.match(appSource, /languages\[language\]\.locale/);
  assert.match(read("launcher", "src", "settings-surface.tsx"), /Object\.keys\(languages\) as Language\[\]/);
});

test("native launcher dialogs and tray actions follow every persisted language", () => {
  for (const language of Object.keys(languages)) {
    assert.match(electronMain, new RegExp(`["']?${language}["']?: Object\\.freeze\\(\\{[\\s\\S]*?openLauncher:`));
  }
  assert.match(electronMain, /return NATIVE_COPY\[language\] \|\| NATIVE_COPY\.en;/);
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


test("plugin setup and Zero Risk instructions show configured names in every language", () => {
  const { copyFor } = loadI18nModule();
  const names = { automatic: "Codex Work", manual: "Codex Manual" };
  for (const language of Object.keys(languages)) {
    const copy = copyFor(language, names);
    for (const key of ["manualMcpStepThreeBody", "manualConnectorNotice", "manualPromptInstruction", "manualPromptWaiting"]) {
      assert.ok(copy[key].includes(names.manual), `${language}: ${key}`);
    }
    assert.ok(copy.connectorMigrationNotice.includes(names.automatic));
    assert.ok(copy.pluginNameWarning.length > 0);
    assert.equal(copyFor(language).manualPromptInstruction.includes("Codex Manual"), false);
  }
});
