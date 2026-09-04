const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const app = read("src/App.tsx");
const main = read("electron/main.cjs");

test("the extracted mode picker selects only the chosen radio and dispatches both choices", () => {
  const exportsObject = {};
  new Function("exports", "require", ts.transpileModule(read("src/interaction-mode-picker.tsx"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText)(exportsObject, name => name === "./icons" ? { Icon() {} } : require(name));
  for (const mode of ["automatic", "manual"]) {
    const choices = [];
    const tree = exportsObject.InteractionModePicker({ copy: {}, disabled: false, mode, onChange: value => choices.push(value) });
    assert.equal(tree.props.role, "radiogroup");
    const buttons = tree.props.children;
    assert.equal(buttons.filter(button => button.props["aria-checked"]).length, 1);
    for (const button of buttons) {
      assert.equal(button.props.role, "radio");
      assert.equal(Boolean(button.props.children[0]), button.key === mode);
      button.props.onClick();
    }
    assert.deepEqual(choices, ["automatic", "manual"]);
    const disabled = exportsObject.InteractionModePicker({ copy: {}, disabled: true, mode, onChange() {} });
    assert.ok(disabled.props.children.every(button => button.props.disabled));
  }
  assert.ok(/useState<BrowserInteractionMode>\(\s*snapshot\.state\.browserInteractionMode,?\s*\)/.test(app));
  assert.match(app, /onChange=\{setSelectedInteractionMode\}/);
  assert.match(app, /completeOnboarding\(selectedLanguage, selectedInteractionMode\)/);
  const css = read("src/styles.css");
  assert.match(css, /\.interaction-mode-picker\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.ok(/\.interaction-mode-picker > button\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/.test(css));
  assert.ok(/\.interaction-mode-picker > button\.is-selected\s*\{[^}]*grid-template-columns:\s*18px minmax\(0, 1fr\)/.test(css));
});

test("manual shell setup does not require authentication or an Automatic catalog", () => {
  const declaration = name => app.match(new RegExp(`const ${name} = [\\s\\S]*?;`))[0];
  const evaluate = new Function("snapshot", "browser", "clientIntegrationInstalled", [
    ...["interactionSetupComplete", "firstRunZeroRiskSetup", "needsBrowser", "needsSetup", "mcpOptional"].map(declaration),
    "return {interactionSetupComplete, firstRunZeroRiskSetup, needsBrowser, needsSetup, mcpOptional};",
  ].join("\n"));
  for (const installed of [false, true]) {
    const value = evaluate({ state: { browserInteractionMode: "manual", coreSetupComplete: true, codexCatalogVerified: false } }, null, installed);
    assert.deepEqual(value, { interactionSetupComplete: true, firstRunZeroRiskSetup: false,
      needsBrowser: false, needsSetup: !installed, mcpOptional: false });
  }
  assert.equal(evaluate({ state: { browserInteractionMode: "manual" } }, null, false).firstRunZeroRiskSetup, true);
  assert.equal(evaluate({ state: { browserInteractionMode: "automatic" } }, null, false).needsBrowser, true);
  assert.match(app, /firstRunZeroRiskSetup \? "mcp"/);
  assert.match(app, /if \(!selectedManualTab\) return;\s*setSurface\("browser"\);\s*setSidebarOpen\(false\);\s*void api!\.setBrowserSurfaceActive\(true\)/);
  assert.match(app, /!manualInteraction && platform === "darwin"/);
  assert.match(app, /!manualInteraction \? <>[\s\S]*?onAction=\{openLogin\}[\s\S]*?onAction=\{smoke\}[\s\S]*?<\/\> : null/);
  assert.match(app, /disabled=\{busy \|\| \(manualInteraction\s*\? snapshot\.state\.mcpRuntimeInstalled !== true/);
});

test("manual Verify checks local health without invoking connector inspection", async () => {
  const start = main.indexOf('  handle("launcher:mcp-verify",');
  const end = main.indexOf('  handle("launcher:doctor",', start);
  for (const profile of [false, true]) {
    let handler;
    let inspections = 0;
    let doctors = 0;
    let state = { browserInteractionMode: "manual" };
    const report = { ok: true, checks: [] };
    const doctor = async () => { doctors++; return report; };
    vm.runInNewContext(main.slice(start, end), {
      handle: (_name, fn) => { handler = fn; }, IS_DEV_PROFILE: profile,
      browserHost: { activeTraceId: null, verifyConnector() { inspections++; } },
      runtimeHost: { doctor, devDoctor: doctor }, mainWindow: null, logger: { info() {} },
      stateStore: { read: () => state, update: patch => { state = { ...state, ...patch }; return state; } },
      send() {}, publishOperation() {},
    });
    assert.equal(await handler({ sender: { isFocused: () => false } }), report);
    assert.equal(doctors, 1);
    assert.equal(inspections, 0);
    assert.equal(state.mcpSetupComplete, true);
  }
  const preload = read("electron/preload.cjs");
  for (const channel of ["browser-interaction-mode", "manual-prompt-copy", "manual-prompt-sent"]) {
    assert.ok(preload.includes(`launcher:${channel}`));
  }
});
