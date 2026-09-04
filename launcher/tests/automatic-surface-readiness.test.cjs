const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { dirname } = require("node:path");
const { runInNewContext } = require("node:vm");
const { BrowserControlServer } = require("../electron/control-server.cjs");
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const navigation = deferred(), marker = deferred(), loading = deferred(), marking = deferred();
  const contents = new EventEmitter();
  let url = "about:blank", closed = false, markerCalls = 0;
  Object.assign(contents, {
    isDestroyed: () => closed, getURL: () => url, setWindowOpenHandler() {}, setZoomFactor() {},
    stop() {}, insertCSS: async () => {}, setBackgroundThrottling() {},
    loadURL: target => { loading.resolve(); return navigation.promise.then(() => {
      url = target; contents.emit("did-finish-load");
    }); },
    executeJavaScript: () => { markerCalls++; marking.resolve(); return marker.promise; },
  });
  const path = require.resolve("../electron/browser-host.cjs"), localRequire = createRequire(path);
  const module = { exports: {} };
  runInNewContext(readFileSync(path, "utf8"), {
    module, exports: module.exports, __dirname: dirname(path), process, Buffer, setTimeout, clearTimeout,
    require: name => name === "electron" ? {
      WebContentsView: class { constructor() { this.webContents = contents; } },
    } : name === "./interaction-shield.cjs" ? {
      TURN_INTERACTION_SHIELD_URL: "fixture-shield",
      createTurnInteractionShield: () => ({ setBounds() {}, setVisible() {}, webContents: { loadURL: async () => {} } }),
    } : localRequire(name),
  }, { filename: path });
  const host = Object.assign(Object.create(module.exports.BrowserHost.prototype), {
    manualOperation: null, turnTabs: new Map(), userCancelledTurnOwners: new Map(),
    partition: "fixture", state: { zoomFactor: 1 }, window: { contentView: { addChildView() {} } },
    logger: { info() {}, warn() {}, error() {} },
    presentTurnView() {}, bindShellZoomShortcuts() {}, syncPowerSaveBlocker() {},
    syncViewVisibility() {}, snapshot: () => ({}), writeDescriptor() {},
    removeTurnTab: tab => { closed = true; host.turnTabs.delete(tab.id); },
  });
  return { host, navigation, marker, loading, marking, markerCalls: () => markerCalls };
}

for (const failure of [null, "navigation", "marker"]) test(`Automatic control lease waits for committed surface and marker: ${failure ?? "success"}`, async () => {
  const f = fixture();
  const control = await new BrowserControlServer({
    getBrowserHost: () => f.host, getPreferences: () => ({}), logger: { info() {}, warn() {}, error() {} },
  }).start();
  const { endpoint, token } = control.descriptor();
  let replied = false;
  const request = fetch(`${endpoint}/v1/turn/start`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ traceId: "fixture-trace", helperPid: process.pid }),
  }).then(response => { replied = true; return response; });
  try {
    await f.loading.promise;
    await tick();
    assert.equal(replied, false, "lease cannot precede navigation commit");
    if (failure === "navigation") f.navigation.reject(new Error("navigation failed"));
    else {
      f.navigation.resolve();
      await f.marking.promise;
      await tick();
      assert.equal(replied, false, "lease cannot precede surface ownership marker");
      if (failure === "marker") f.marker.reject(new Error("marker failed"));
      else f.marker.resolve();
    }
    const response = await request;
    assert.equal(response.status, failure ? 400 : 200);
    const result = await response.json();
    if (failure) assert.equal(f.host.turnTabs.size, 0);
    else {
      assert.equal(typeof result.surfaceId, "string");
      assert.equal(f.host.turnTabs.has(result.tabId), true);
      assert.equal(f.markerCalls(), 1);
    }
  } finally {
    f.navigation.resolve(); f.marker.resolve();
    await request;
    await control.close();
  }
});

test("parallel traces cannot both acquire the same retained tab", async () => {
  const f = fixture();
  f.navigation.resolve(); f.marker.resolve();
  const original = await f.host.beginTurn("fixture-initial", false, process.pid, true, "retained", "fixture-connector");
  const tab = f.host.turnTabs.get(original.tabId);
  tab.status = "ready"; tab.connectorBound = true;
  const leases = await Promise.allSettled([
    f.host.beginTurn("fixture-next-A", false, process.pid, true, "retained", "fixture-connector", true),
    f.host.beginTurn("fixture-next-B", false, process.pid, true, "retained", "fixture-connector", true),
  ]);
  assert.equal(leases.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(tab.traceId, "fixture-next-A");
  assert.equal(f.host.turnTabs.size, 1);
});
