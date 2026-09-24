const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const test = require("node:test");
const vm = require("node:vm");
const { BrowserHost, IDLE_BROWSER_URL } = require("../electron/browser-host.cjs");

test("the production browser binding forwards manual main-frame navigation", () => {
  const calls = [];
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = () => {};
  contents.getURL = () => "https://chatgpt.com/c/retained";
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    manualTurns: { navigation: (...args) => calls.push(args) },
    publishState() {},
    snapshot() { return {}; },
    syncViewVisibility() {},
  });
  const tab = {
    id: "tab-1",
    traceId: "trace-1",
    interactionMode: "manual",
    view: { webContents: contents },
  };
  host.bindTurnContents(tab);

  contents.emit("did-start-navigation", {}, "https://chatgpt.com/c/reload", false, true);
  contents.emit("did-navigate-in-page", {}, "https://chatgpt.com/c/reload#answer", true);
  contents.emit("did-start-navigation", {}, "https://example.com/frame", false, false);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(([, url, inPlace]) => [url, inPlace]), [
    ["https://chatgpt.com/c/reload", false],
    ["https://chatgpt.com/c/reload#answer", true],
  ]);
});

test("a manual tab owns its initial navigation before loadURL starts", async () => {
  const source = require.resolve("../electron/browser-host.cjs");
  class FakeContents extends EventEmitter {
    setWindowOpenHandler() {}
    setZoomFactor() {}
    isDestroyed() { return false; }
    getURL() { return this.url ?? "about:blank"; }
    stop() {}
    loadURL(url) {
      this.url = url;
      this.emit("did-start-navigation", {}, url, false, true);
      return Promise.resolve();
    }
  }
  class FakeWebContentsView {
    constructor() { this.webContents = new FakeContents(); }
  }
  const nativeRequire = createRequire(source);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(source, "utf8"), {
    require(id) {
      if (id === "electron") return {
        clipboard: { writeText() {} },
        WebContentsView: FakeWebContentsView,
        powerMonitor: null,
        powerSaveBlocker: {},
        shell: { openExternal() {} },
      };
      return nativeRequire(id);
    },
    module,
    exports: module.exports,
    __filename: source,
    __dirname: require("node:path").dirname(source),
    Buffer,
    URL,
    process,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
  });

  let navigationState;
  const host = Object.assign(Object.create(module.exports.BrowserHost.prototype), {
    turnTabs: new Map(),
    window: { contentView: { addChildView() {} } },
    partition: "persist:codex-web-gpt-chatgpt",
    state: { zoomFactor: 1 },
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    logger: { error() {} },
    manualTurns: {
      navigation(tab) {
        navigationState = {
          state: tab.manualState,
          reused: tab.manualConversationReused,
        };
        if (tab.conversationKey && tab.manualState !== "awaiting-user") {
          tab.conversationKey = undefined;
        }
      },
    },
    syncPowerSaveBlocker() {},
    presentTurnView() {},
    bindShellZoomShortcuts() {},
    publishState() {},
    snapshot() { return {}; },
    syncViewVisibility() {},
  });

  const tab = host.createManualTurnTab("trace-bootstrap", 10, "conversation-key");

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(navigationState, { state: "awaiting-user", reused: false });
  assert.equal(tab.conversationKey, "conversation-key");
});

function manualTabNavigationFixture(remoteError, chatUrl = "https://chatgpt.com/?temporary-chat=true") {
  const calls = [];
  const logs = [];
  const terminal = [];
  let currentUrl = "about:blank";
  const contents = new EventEmitter();
  contents.isDestroyed = () => false;
  contents.getURL = () => currentUrl;
  contents.stop = () => calls.push("stop");
  contents.loadURL = async (url) => {
    calls.push(["load", url]);
    if (url === IDLE_BROWSER_URL) {
      currentUrl = url;
      return;
    }
    throw remoteError;
  };
  const tab = {
    id: "manual-edit-retry",
    url: chatUrl,
    traceId: "trace-edit-retry",
    manualState: "awaiting-user",
    view: { webContents: contents },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    getBrowserInteractionMode: () => "manual",
    turnTabs: new Map([[tab.id, tab]]),
    logger: {
      info: (event, detail) => logs.push(["info", event, detail]),
      error: (event, detail) => logs.push(["error", event, detail]),
    },
    manualTurns: { removed(_tab, status) { terminal.push(status); } },
    removeTurnTab(removed) { this.turnTabs.delete(removed.id); },
  });
  return { calls, fixture, logs, tab, terminal };
}

test("manual edit retry survives Electron superseding the ChatGPT navigation", async () => {
  for (const chatUrl of ["https://chatgpt.com/?temporary-chat=true", "https://chatgpt.com/"]) {
    const observed = manualTabNavigationFixture(
      new Error(`ERR_ABORTED (-3) loading ${chatUrl}`), chatUrl,
    );

    await observed.fixture.initializeManualTurnTab(observed.tab);

    assert.deepEqual(observed.calls, [
      ["load", IDLE_BROWSER_URL],
      ["load", chatUrl],
    ]);
    assert.equal(observed.fixture.turnTabs.has(observed.tab.id), true);
    assert.deepEqual(observed.terminal, []);
    assert.equal(observed.logs.some(([level]) => level === "error"), false);
  }
});

test("manual ChatGPT navigation still fails closed on a real load failure", async () => {
  const failure = new Error("ERR_FAILED (-2) loading 'https://chatgpt.com/?temporary-chat=true'");
  failure.code = "ERR_FAILED";
  const observed = manualTabNavigationFixture(failure);

  await observed.fixture.initializeManualTurnTab(observed.tab);

  assert.equal(observed.fixture.turnTabs.has(observed.tab.id), false);
  assert.deepEqual(observed.terminal, ["failed"]);
  assert.equal(observed.logs.some(([, event]) => event === "browser.manual_tab_initialization_failed"), true);
});
