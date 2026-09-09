const assert = require("node:assert/strict");
const test = require("node:test");
const {
  beginSystemRevision,
  commitSystemRevision,
  selectSystemRevisionMode,
} = require("../electron/retained-system-revision.cjs");
const { BrowserHost } = require("../electron/browser-host.cjs");

test("retained system revisions select full, resume, and refresh without early commit", () => {
  const first = "a".repeat(64);
  const changed = "b".repeat(64);
  const tab = {};

  assert.equal(beginSystemRevision(tab, first, false), "full");
  assert.equal(tab.systemRevision, undefined);
  assert.equal(tab.pendingSystemRevision, first);
  commitSystemRevision(tab);
  assert.equal(tab.systemRevision, first);
  assert.equal(beginSystemRevision(tab, first, true), "resume");
  commitSystemRevision(tab);
  assert.equal(selectSystemRevisionMode(tab, changed, true), "refresh");
  assert.equal(tab.systemRevision, first);
  assert.equal(tab.pendingSystemRevision, undefined);
  assert.equal(beginSystemRevision(tab, changed, true), "refresh");
  assert.equal(tab.systemRevision, first);
  commitSystemRevision(tab);
  assert.equal(tab.systemRevision, changed);
});

test("a retained tab without a recorded revision refreshes exactly once", () => {
  const revision = "c".repeat(64);
  const tab = {};
  assert.equal(beginSystemRevision(tab, revision, true), "refresh");
  commitSystemRevision(tab);
  assert.equal(beginSystemRevision(tab, revision, true), "resume");
  assert.throws(() => beginSystemRevision(tab, "invalid", true), /invalid/);
});

test("automatic browser ownership reuses the retained surface for a changed system revision", async () => {
  const previous = "d".repeat(64);
  const changed = "e".repeat(64);
  const tab = {
    id: "retained-tab", surfaceId: "retained-surface", traceId: "old-trace",
    conversationKey: "conversation", connectorIdentity: "Codex Native2", connectorBound: true,
    interactionMode: "automatic", helperPid: process.pid, status: "ready", systemRevision: previous,
    view: { webContents: { isDestroyed: () => false, setBackgroundThrottling() {} } },
  };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null,
    turnTabs: new Map([[tab.id, tab]]),
    userCancelledTurnOwners: new Map(),
    selectedTabId: "home",
    syncViewVisibility() {},
    snapshot: () => ({ tabs: [] }),
    publishState() {},
    writeDescriptor() {},
    logger: { info() {}, warn() {} },
  });
  const lease = await host.beginTurn(
    "new-trace", false, process.pid, true, "conversation", "Codex Native2", false, changed,
  );
  assert.equal(lease.tabId, tab.id);
  assert.equal(lease.reused, true);
  assert.equal(lease.promptMode, "refresh");
  assert.equal(tab.systemRevision, previous);
  assert.equal(tab.pendingSystemRevision, changed);
});

test("a completed retained trace retries against its committed revision", async () => {
  const revision = "f".repeat(64);
  const tab = {
    id: "retained-tab", surfaceId: "retained-surface", traceId: "same-trace",
    conversationKey: "conversation", connectorIdentity: "Codex Native2", connectorBound: true,
    interactionMode: "automatic", helperPid: process.pid, status: "ready", systemRevision: revision,
    view: { webContents: { isDestroyed: () => false, setBackgroundThrottling() {} } },
  };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null, turnTabs: new Map([[tab.id, tab]]), userCancelledTurnOwners: new Map(),
    selectedTabId: "home", syncViewVisibility() {}, snapshot: () => ({ tabs: [] }),
    publishState() {}, writeDescriptor() {}, logger: { info() {}, warn() {} },
  });
  const lease = await host.beginTurn(
    "same-trace", false, process.pid, true, "conversation", "Codex Native2", false, revision, true,
  );
  assert.equal(lease.promptMode, "resume");
});

test("a browser-only system change replaces the retained tab with a full surface", async () => {
  const previous = "1".repeat(64);
  const changed = "2".repeat(64);
  const retained = {
    id: "retained-tab", surfaceId: "retained-surface", traceId: "old-trace",
    conversationKey: "conversation", interactionMode: "automatic", helperPid: process.pid,
    status: "ready", systemRevision: previous,
    view: { webContents: { isDestroyed: () => false, setBackgroundThrottling() {} } },
  };
  const fresh = { id: "fresh-tab", surfaceId: "fresh-surface" };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null, turnTabs: new Map([[retained.id, retained]]), userCancelledTurnOwners: new Map(),
    removeTurnTab(tab) { this.turnTabs.delete(tab.id); },
    async createTurnTab() { return fresh; },
    selectedTabId: "home", syncViewVisibility() {}, snapshot: () => ({ tabs: [] }),
    publishState() {}, writeDescriptor() {}, logger: { info() {}, warn() {} },
  });
  const lease = await host.beginTurn(
    "new-trace", false, process.pid, true, "conversation", undefined, false, changed, false,
  );
  assert.deepEqual(lease, { surfaceId: "fresh-surface", tabId: "fresh-tab", reused: false, promptMode: "full" });
  assert.equal(host.turnTabs.has(retained.id), false);
});
