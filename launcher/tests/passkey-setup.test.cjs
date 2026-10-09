const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

test('Setup passkey action follows browser phase through remounts', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
  const setup = source.slice(source.indexOf('function SetupSurface('), source.indexOf('function McpSurface('));
  const sandbox = {
    element: (type, props, ...children) => ({ type, props, children }),
    useState: value => [value, () => {}], useEffect() {},
    hasClientIntegration: () => false,
  };
  for (const name of ['ContentSurface', 'SectionHeading', 'SetupRow', 'NoticeRow', 'Icon']) sandbox[name] = name;
  // Execute the actual renderer; each render starts with remounted local state.
  const context = vm.createContext({ ...sandbox, fragment: 'fragment' });
  vm.runInContext(ts.transpileModule(setup, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'element', jsxFragmentFactory: 'fragment',
  } }).outputText + '\nrender = SetupSurface;', context);
  const visit = tree => Array.isArray(tree) ? tree.flatMap(visit) : tree && typeof tree === 'object'
    ? [tree, ...visit(tree.children ?? [])] : [];
  const copy = { passkeyOpening: 'Opening Chrome', passkeyContinue: 'Continue', passkeyImporting: 'Importing', passkeySignIn: 'Sign in' };
  for (const [phase, label, disabled] of [['opening', copy.passkeyOpening, true],
    ['waiting', copy.passkeyContinue, false], ['importing', copy.passkeyImporting, true]]) {
    const tree = context.render({ browser: { authenticated: false, passkeyPhase: phase, status: 'loading' }, copy,
      operation: { name: 'passkey-login', status: 'running' }, snapshot: { platform: 'darwin', state: {} },
      activateBrowser() {}, setError() {}, showMcp() {}, updateState() {}, devProfile: false });
    const row = visit(tree).find(node => node.type === 'SetupRow' && node.props.index === 1);
    assert.equal(row.props.secondaryAction, label);
    assert.equal(row.props.secondaryDisabled, disabled);
  }
});

test('runtime upgrade does not copy a removed bridge preference into launcher state', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  assert.doesNotMatch(source, /bridgeEnabled: upgrade\.bridgeEnabled/);
});

test("passkey buttons show launch progress, wait for Chrome, and preserve import progress after remount", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/App.tsx"), "utf8");
  const vm = require("node:vm");
  const surface = source.slice(source.indexOf("function BrowserSurface("), source.indexOf("function SetupSurface("));
  const transpile = (source, fileName) => ts.transpileModule(source, { fileName, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: "element",
  } }).outputText;
  const load = file => {
    const module = { exports: {} };
    vm.runInNewContext(transpile(fs.readFileSync(file, "utf8"), file), {
      module, exports: module.exports, require: name => load(path.resolve(path.dirname(file), name + ".ts")),
    });
    return module.exports;
  };
  const translated = { exports: load(path.join(path.join(__dirname, '..'), "src/i18n.ts")) };
  let state = [], cursor = 0, finishLogin, opens = 0, continues = 0;
  const sandbox = {
    element: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: value => { const index = cursor++; if (!(index in state)) state[index] = value;
      return [state[index], next => { state[index] = next; }]; },
    useEffect() {}, messageOf: String, formatBrowserAddress: () => "chatgpt.com",
    api: {
      openPasskeyLogin: () => { opens++; return new Promise(resolve => { finishLogin = resolve; }); },
      continuePasskeyLogin: async () => { continues++; },
    },
  };
  for (const name of ["BrandMark", "Icon", "IconButton", "PrimaryButton", "SecondaryButton", "ManualTurnGuide"]) sandbox[name] = name;
  vm.runInNewContext(transpile(surface, "surface.tsx") + "\nrender = BrowserSurface;", sandbox);
  const copy = translated.exports.copyFor("en");
  const props = { browser: { authenticated: false, visible: false, tabs: [] }, copy, operation: null,
    platform: "darwin", interactionMode: "automatic", browserSlotRef() {}, setError(error) { if (error) throw new Error(error); } };
  const visit = tree => Array.isArray(tree) ? tree.flatMap(visit) : tree && typeof tree === "object"
    ? [tree, ...visit(tree.children ?? [])] : [];
  const render = () => { cursor = 0; return visit(sandbox.render(props)); };
  const action = () => render().find(node => node.type === "SecondaryButton");
  props.operation = { status: "running", name: "doctor", message: "Checking runtime" };
  assert.equal(action().props.disabled, true);
  props.operation = null;
  const started = action().props.onClick();
  assert.equal(opens, 1);
  assert.deepEqual(action().children, [copy.passkeyOpening]);
  assert.equal(action().props.disabled, true);
  props.browser.passkeyPhase = "waiting";
  assert.deepEqual(action().children, [copy.passkeyContinue]);
  assert.equal(action().props.disabled, false);
  await action().props.onClick();
  assert.equal(continues, 1);
  assert.deepEqual(action().children, [copy.passkeyImporting]);
  props.browser.passkeyPhase = "importing";
  state = []; // Changing launcher sections must not reset a running import to Continue.
  assert.deepEqual(action().children, [copy.passkeyImporting]);
  assert.equal(action().props.disabled, true);
  props.browser.visible = true;
  assert.ok(render().some(node => node.props.className === "passkey-login-guide"));
  props.browser.authenticated = true;
  props.browser.passkeyPhase = null;
  finishLogin();
  await started;
  assert.equal(action(), undefined);
  for (const language of Object.keys(require("../electron/languages.json"))) {
    const localized = translated.exports.copyFor(language);
    for (const key of ["passkeyContinue", "passkeyContinueBody", "passkeyOpening", "passkeyOpeningBody", "passkeyWaitingTitle", "passkeyImportingBody"]) {
      assert.ok(localized[key].length > 5);
    }
  }
});
