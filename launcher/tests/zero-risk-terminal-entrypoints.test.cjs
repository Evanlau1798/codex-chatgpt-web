const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { dirname } = require("node:path");
const { runInNewContext } = require("node:vm");
const { BrowserHost } = require("../electron/browser-host.cjs");
const { ManualTurnController } = require("../electron/manual-turn-controller.cjs");

function fixture() {
  const contents = new EventEmitter();
  let closed = false;
  Object.assign(contents, {
    setWindowOpenHandler() {}, getURL: () => "https://chatgpt.com/",
    isDestroyed: () => closed, close: () => { closed = true; },
  });
  const tab = {
    id: "tab-manual", traceId: "trace-manual", helperPid: process.pid,
    interactionMode: "manual", status: "running", manualState: "awaiting-user",
    manualWaiters: new Set(), manualTerminalWaiters: new Set(), view: { webContents: contents },
  };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]), closedTurnOwners: new Map(), userCancelledTurnOwners: new Map(),
    window: { contentView: { removeChildView() {} } }, selectedTabId: tab.id,
    syncViewVisibility() {}, syncPowerSaveBlocker() {}, writeDescriptor() {}, publishState() {},
    snapshot() { return { tabs: [...this.turnTabs.keys()] }; },
    logger: { info() {}, warn() {}, error() {} },
  });
  host.manualTurns = new ManualTurnController({ host, logger: host.logger, clipboard: {} });
  return { host, tab, contents };
}

test("manual UI close notifies both observers before a failing cancellation RPC", async () => {
  const { host, tab, contents } = fixture();
  const sibling = { id: "sibling", traceId: "trace-other", status: "running" };
  host.turnTabs.set(sibling.id, sibling);
  const sent = host.manualTurns.waitSent(tab.traceId, tab.helperPid);
  const terminal = host.manualTurns.waitTerminal(tab.traceId, tab.helperPid);
  host.cancelTurn = async () => {
    assert.equal(host.manualTurns.terminals.get(tab.traceId)?.status, "cancelled");
    throw new Error("cancellation RPC unavailable");
  };
  await host.closeTab(tab.id);
  assert.deepEqual(await sent, { status: "cancelled" });
  assert.deepEqual(await terminal, { status: "cancelled" });
  assert.equal(host.turnTabs.has(tab.id), false);
  assert.equal(contents.isDestroyed(), true);
  assert.equal(host.turnTabs.get(sibling.id), sibling);
});

for (const [name, event] of [
  ["navigation", ["did-fail-load", {}, -2, "ERR_FAILED", "https://chatgpt.com/", true]],
  ["renderer", ["render-process-gone", {}, { reason: "crashed", exitCode: 1 }]],
]) test(`manual ${name} failure reaches both observers as failure, not cancellation`, async () => {
  const { host, tab, contents } = fixture();
  const sent = host.manualTurns.waitSent(tab.traceId, tab.helperPid);
  const terminal = host.manualTurns.waitTerminal(tab.traceId, tab.helperPid);
  host.bindTurnContents(tab);
  contents.emit(...event);
  assert.deepEqual(await sent, { status: "failed" });
  assert.deepEqual(await terminal, { status: "failed" });
  assert.equal(host.turnTabs.size, 0);
  assert.equal(contents.isDestroyed(), true);
});

test("manual initial navigation rejection fails and releases the new surface", async () => {
  const { host, contents } = fixture();
  host.turnTabs.clear();
  Object.assign(contents, {
    setZoomFactor() {}, loadURL: async () => { throw new Error("initial navigation failed"); },
  });
  const path = require.resolve("../electron/browser-host.cjs");
  const localRequire = createRequire(path);
  const module = { exports: {} };
  runInNewContext(readFileSync(path, "utf8"), {
    module, exports: module.exports, __dirname: dirname(path), process, Buffer, setTimeout, clearTimeout,
    require: name => name === "electron" ? {
      WebContentsView: class { constructor() { this.webContents = contents; } },
    } : localRequire(name),
  }, { filename: path });
  Object.assign(host, {
    partition: "test", state: { zoomFactor: 1 },
    presentTurnView() {}, bindShellZoomShortcuts() {}, presentManualTurn() {},
    createTurnTab: module.exports.BrowserHost.prototype.createTurnTab,
  });
  host.window.contentView.addChildView = () => {};
  host.manualTurns.clipboard.writeText = () => {};
  const lease = host.manualTurns.begin("trace-initial", process.pid, "test");
  const tab = host.turnTabs.get(lease.tabId);
  const sent = host.manualTurns.waitSent(tab.traceId, tab.helperPid);
  const terminal = host.manualTurns.waitTerminal(tab.traceId, tab.helperPid);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await sent, { status: "failed" });
  assert.deepEqual(await terminal, { status: "failed" });
  assert.equal(host.turnTabs.size, 0);
});
