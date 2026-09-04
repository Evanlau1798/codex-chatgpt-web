const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { BrowserHost, IDLE_BROWSER_URL } = require("../electron/browser-host.cjs");

test("manual turn navigation never injects code, styles, or page-derived titles", async () => {
  const calls = [];
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = () => {};
  contents.getURL = () => "https://chatgpt.com/?temporary-chat=true";
  for (const method of ["insertCSS", "executeJavaScript", "getTitle"]) {
    contents[method] = () => { calls.push(method); return Promise.resolve(); };
  }
  const tab = { view: { webContents: contents }, interactionMode: "manual", pageTitle: "ChatGPT" };
  const host = {
    logger: { warn() {}, error() {}, info() {} },
    syncViewVisibility() {}, snapshot() {}, publishState() {}, syncPowerSaveBlocker() {},
  };
  BrowserHost.prototype.bindTurnContents.call(host, tab);
  contents.emit("did-finish-load");
  contents.emit("page-title-updated", {}, "private conversation title");
  await Promise.resolve();
  assert.deepEqual(calls, []);
  assert.equal(tab.pageTitle, "ChatGPT");
});

test("Zero Risk fails closed at every primary-surface inspection boundary", async () => {
  let domOperations = 0;
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    getBrowserInteractionMode: () => "manual",
    view: { webContents: {
      isDestroyed: () => false, getURL: () => "https://chatgpt.com/?temporary-chat=true",
      executeJavaScript: async () => { domOperations += 1; },
      insertCSS: async () => { domOperations += 1; return "css-key"; },
      removeInsertedCSS: async () => { domOperations += 1; },
    } },
    viewportCssKey: null, surfaceId: "manual-surface",
  });
  for (const name of [
    "applyViewportCss", "markOwnedSurface", "probeAuthentication", "inspectSession", "runSessionInspection",
    "openLogin", "openPasskeyLogin", "installPasskeyLogin", "logout", "refreshAuthentication",
    "smokeTest", "runSmokeTest", "verifyConnector", "runConnectorVerification", "reveal",
  ]) {
    await assert.rejects(async () => fixture[name](), { code: "manual_browser_inspection_disabled" }, name);
  }
  assert.equal(domOperations, 0);
});

test("Zero Risk reveal navigates without inspecting the ChatGPT DOM", async () => {
  const calls = [];
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    getBrowserInteractionMode: () => "manual",
    show: () => calls.push("show"), selectedTurnTab: () => null,
    view: { webContents: { getURL: () => IDLE_BROWSER_URL, loadURL: async url => calls.push(["load", url]) } },
    probeAuthentication: async () => { throw new Error("manual reveal must not inspect the DOM"); },
    snapshot: () => ({ visible: true }),
  });
  assert.deepEqual(await fixture.reveal(false), { visible: true });
  assert.deepEqual(calls, ["show", ["load", "https://chatgpt.com/?temporary-chat=true"]]);
});

test("manual primary navigation does not inject code or publish page titles", async () => {
  const operations = [];
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = () => {};
  contents.getURL = () => "https://chatgpt.com/?temporary-chat=true";
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    getBrowserInteractionMode: () => "manual", view: { webContents: contents },
    state: { title: "ChatGPT", status: "loading" }, turnTabs: new Map(), manualOperation: null,
    clearHomeNavigationTimeout() {},
    setState(patch) { Object.assign(this.state, patch); },
    applyViewportCss: async () => operations.push("css"),
    markOwnedSurface: async () => operations.push("ownership"),
    probeAuthentication: async () => operations.push("probe"),
    logger: { error() {} },
  });
  fixture.bindWebContents();
  contents.emit("did-finish-load");
  contents.emit("page-title-updated", {}, "private page title");
  contents.emit("did-stop-loading");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(operations, []);
  assert.equal(fixture.state.title, "ChatGPT");
  assert.equal(fixture.state.status, "idle");
});

test("manual primary initialization skips ownership injection and snapshot title reads", async () => {
  let pageReads = 0;
  const contents = new EventEmitter();
  contents.isDestroyed = () => false;
  contents.isLoading = () => false;
  contents.getZoomFactor = () => 1;
  contents.getURL = () => IDLE_BROWSER_URL;
  contents.loadURL = async () => {};
  contents.getTitle = () => { pageReads++; return "private title"; };
  contents.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    getBrowserInteractionMode: () => "manual",
    view: { webContents: contents, setBounds() {}, setVisible() {} },
    hiddenTurnBounds: () => ({}), syncViewVisibility() {}, writeDescriptor() {},
    markOwnedSurface: async () => { pageReads++; }, logger: { info() {} },
    state: { title: "prior private title", status: "idle" }, turnTabs: new Map(), selectedTabId: "home",
    activeView() { return this.view; },
  });
  await fixture.initializePrimaryView();
  const snapshot = fixture.snapshot();
  assert.equal(pageReads, 0);
  assert.equal(snapshot.title, "ChatGPT");
  assert.equal(snapshot.tabs[0].title, "ChatGPT");
});

test("manual primary resize and backend callbacks perform no automatic page work", () => {
  const calls = [];
  let callback;
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    getBrowserInteractionMode: () => "manual", turnTabs: new Map(), window: { getContentSize: () => [900, 700] },
    view: { webContents: {
      executeJavaScript: async () => calls.push("resize"),
      session: { webRequest: { onCompleted(_filter, handler) { callback = handler; } } },
    } },
    syncViewVisibility() {}, handleChatGptBackendResponse: () => calls.push("recovery"),
  });
  fixture.bindChatGptBackendRecovery();
  callback({});
  fixture.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  assert.deepEqual(calls, []);
});

test("launcher startup and reveal wiring honor manual mode without probing", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const start = source.indexOf('  const launcherSmokeTest = process.argv.includes("--launcher-smoke-test");');
  const end = source.indexOf("  await loadRenderer(mainWindow);", start);
  assert.ok(start >= 0 && end > start);
  const reveal = source.match(/handle\("launcher:browser-show",[\s\S]*?\);/)[0];
  for (const mode of ["manual", "automatic"]) {
    const calls = [];
    const context = {
      process: { argv: [] }, stateStore: { read: () => ({ browserInteractionMode: mode }) },
      browserHost: { refreshAuthentication: async () => calls.push("refresh"), reveal: inspect => calls.push(inspect) },
      handle: (_name, callback) => callback(), logger: { warn() {} },
    };
    vm.runInNewContext(source.slice(start, end), context);
    vm.runInNewContext(reveal, context);
    await Promise.resolve();
    assert.deepEqual(calls, mode === "manual" ? [false] : ["refresh", true]);
  }
});

test("manual login rejects the fork Chrome chooser and external login before any side effect", async () => {
  const { openBrowserLogin, openExternalLogin } = require("../electron/browser-login-flow.cjs");
  const host = { getBrowserInteractionMode: () => "manual" };
  await assert.rejects(openBrowserLogin({ browserHost: host }), { code: "manual_browser_inspection_disabled" });
  await assert.rejects(async () => openExternalLogin(host, {}), { code: "manual_browser_inspection_disabled" });
});
