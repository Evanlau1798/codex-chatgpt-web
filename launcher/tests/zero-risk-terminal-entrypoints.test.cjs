const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
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
