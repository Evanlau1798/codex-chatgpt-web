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
const loadI18nModule = require("./support/i18n.cjs");

test("every declared launcher language is wired across state, IPC, onboarding, and Settings", () => {
  assert.deepEqual(Object.keys(languages), ["en", "zh-CN", "zh-TW", "ja", "ko", "fr"]);
  assert.match(languageTypes, /import languages from "\.\.\/electron\/languages\.json";/);
  assert.match(languageTypes, /export type Language = keyof typeof languages;/);
  assert.match(stateSource, /Object\.hasOwn\(languages, state\.language\)/);
  assert.match(electronMain, /Object\.hasOwn\(languages, value\)/);
  assert.match(i18nSource, /import \{ ja \} from "\.\/i18n-ja"/);
  assert.match(i18nSource, /import \{ ko \} from "\.\/i18n-ko"/);
  assert.match(i18nSource, /import \{ zhTW \} from "\.\/i18n-zh-tw"/);
  assert.match(i18nSource, /import \{ fr \} from "\.\/i18n-fr"/);
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


test("runtime localization preserves literal plugin names, endpoints and all catalog states", () => {
  const { copyFor, localizeRuntimeMessage } = loadI18nModule();
  for (const language of Object.keys(languages).filter(language => language !== "en")) {
    const copy = copyFor(language);
    for (const name of ["Codex Native2", "Native $&", "Native $'", "Native $`", "Native $1",
      'Native "quoted"', "Native \\path", "Native \u2028X", "Native \u2029X"]) {
      assert.equal(localizeRuntimeMessage(copy, `ChatGPT connector ${JSON.stringify(name)} is available`, "connector", language),
        copy.doctorConnectorAvailable.replace("{name}", () => name));
    }
    assert.equal(localizeRuntimeMessage(copy, "Responses proxy is healthy on 127.0.0.1:17841", "proxy", language),
      copy.doctorProxyHealthy.replace("{endpoint}", () => "127.0.0.1:17841"));
    for (const [message, expected] of [
      ["This runtime has not observed a completed Codex model-list request yet", copy.doctorCatalogPending],
      ["Codex's latest model-list request succeeded", copy.doctorCatalogReady],
      ["Codex's latest model-list request failed; the local runtime is reachable", copy.doctorCatalogFailed],
    ]) assert.equal(localizeRuntimeMessage(copy, message, "model-catalog", language), expected);
  }
});

test("DoctorSummary translates known warning and error checks while preserving unknown failures", () => {
  const vm = require("node:vm");
  const { copyFor, localizeRuntimeMessage } = loadI18nModule();
  const source = read("launcher", "src", "app-shared.tsx");
  const ast = ts.createSourceFile("app-shared.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const summary = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "DoctorSummary");
  assert.ok(summary);
  const sandbox = { localizeRuntimeMessage, Icon: "Icon", StateDot: "StateDot",
    element: (type, props, ...children) => ({ type, props, children }) };
  const js = ts.transpileModule(summary.getText(ast).replace(/^export /, ""), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: "element",
  }, fileName: "summary.tsx" }).outputText;
  vm.runInNewContext(js + "\nrender = DoctorSummary;", sandbox);
  const spans = tree => !tree || typeof tree !== "object" ? [] : Array.isArray(tree)
    ? tree.flatMap(spans) : [...(tree.type === "span" ? tree.children : []), ...spans(tree.children)];
  for (const language of Object.keys(languages)) {
    const copy = copyFor(language);
    const raw = "Unknown backend failure with literal $& and 127.0.0.1:17841";
    for (const status of ["ok", "warning", "error"]) {
      const checks = [
        ["This runtime has not observed a completed Codex model-list request yet", copy.doctorCatalogPending],
        ["Codex's latest model-list request succeeded", copy.doctorCatalogReady],
        ["Codex's latest model-list request failed; the local runtime is reachable", copy.doctorCatalogFailed],
      ];
      const rendered = sandbox.render({ copy, language, report: { ok: status === "ok", checks: [
        ...checks.map(([message]) => ({ id: "model-catalog", status, message })),
        { id: "unknown", status, message: raw },
      ] } });
      assert.deepEqual(spans(rendered), [...checks.map(([message, translated]) => language === "en" ? message : translated), raw]);
    }
  }
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
