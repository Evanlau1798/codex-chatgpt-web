const test = require("node:test");
const assert = require("node:assert/strict");
const { BrowserHost } = require("../electron/browser-host.cjs");

function fixture(tabs, limit = 3) {
  let allocations = 0;
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null, turnTabs: new Map(tabs.map(tab => [tab.id, tab])),
    userCancelledTurnOwners: new Map(), closedTurnOwners: new Map(), getMaxBrowserTabs: () => limit,
    logger: { info() {}, warn() {} }, syncViewVisibility() {}, show() {},
    snapshot: () => ({}), publishState() {}, writeDescriptor() {},
    createTurnTab: async (traceId, helperPid, _locked, conversationKey, connectorIdentity) => {
      allocations++;
      const tab = { id: "cold", surfaceId: "c".repeat(32), traceId, helperPid, conversationKey, connectorIdentity };
      host.turnTabs.set(tab.id, tab); return tab;
    },
  });
  return { host, get allocations() { return allocations; } };
}
const ready = (extra = {}) => ({ id: "warm", surfaceId: "w".repeat(32), traceId: "startup_old", helperPid: process.pid,
  connectorIdentity: "Codex Native2", connectorBound: true, interactionMode: "automatic", status: "ready",
  startupPreparation: true, startupReady: true, bootstrapReady: true,
  view: { webContents: { isDestroyed: () => false, setBackgroundThrottling() {} } }, ...extra });

test("one prepared page transfers ownership without allocating or replaying a conversation", async () => {
  const warm = ready(), f = fixture([warm]);
  const lease = await f.host.beginTurn("trace_new", false, process.pid, true, "a".repeat(64), "Codex Native2",
    false, undefined, { surfaceId: warm.surfaceId });
  assert.equal(f.allocations, 0);
  assert.equal(f.host.turnTabs.size, 1);
  assert.equal(lease.startupPrepared, true);
  assert.equal(lease.reused, false);
  assert.equal(warm.traceId, "trace_new");
  assert.equal(warm.startupPreparation, false);
  assert.equal(warm.bootstrapReady, true);
});

test("speculative startup does not evict a retained page at the configured capacity", async () => {
  const retained = ready({ startupPreparation: false, startupReady: false, conversationKey: "a".repeat(64) });
  const f = fixture([retained], 1);
  await assert.rejects(f.host.beginTurn("startup_new", false, process.pid, true, undefined, "Codex Native2",
    false, undefined, { preparing: true }), /capacity/);
  assert.equal(f.allocations, 0);
  assert.equal(f.host.turnTabs.get(retained.id), retained);
});

test("preparing a standby during work adds a tab without stealing its visible selection", async () => {
  const running = ready({ id: "running", startupPreparation: false, status: "running" });
  const f = fixture([running]);
  f.host.selectedTabId = running.id;
  await f.host.beginTurn("startup_next", false, process.pid, true, undefined, "Codex Native2",
    false, undefined, { preparing: true });
  assert.equal(f.host.turnTabs.size, 2);
  assert.equal(f.host.selectedTabId, running.id);
});

for (const extra of [{ helperPid: process.pid + 1000 }, { startupReady: false }, { authenticationRequired: true },
  { connectorIdentity: "Other connector" }]) {
  test(`prepared claim fails closed for ${Object.keys(extra)[0]}`, async () => {
    const warm = ready(extra), f = fixture([warm]);
    const lease = await f.host.beginTurn("trace_new", false, process.pid, true, undefined, "Codex Native2",
      false, undefined, { surfaceId: warm.surfaceId });
    assert.equal(f.allocations, 1);
    assert.equal(lease.startupPrepared, undefined);
    assert.equal(warm.traceId, "startup_old");
  });
}

test("retained continuity is never substituted with an unsent startup page", async () => {
  const warm = ready(), f = fixture([warm]);
  await assert.rejects(f.host.beginTurn("trace_new", false, process.pid, true, "a".repeat(64), "Codex Native2",
    true, undefined, { surfaceId: warm.surfaceId }), /no longer available/);
  assert.equal(f.allocations, 0);
  assert.equal(warm.traceId, "startup_old");
});

test("disable closes only unsent standby, retaining TTL conversations and active work", () => {
  const warm = ready(), retained = ready({ id: "retained", startupPreparation: false, conversationKey: "a".repeat(64) });
  const running = ready({ id: "running", startupPreparation: false, status: "running" });
  const f = fixture([warm, retained, running]);
  f.host.removeTurnTab = tab => f.host.turnTabs.delete(tab.id);
  assert.deepEqual(f.host.discardStartupPages(), { closed: 1 });
  assert.equal(f.host.turnTabs.get(retained.id), retained);
  assert.equal(f.host.turnTabs.get(running.id), running);
});

test("standby UI distinguishes preparing and ready pages from completed TTL sessions", () => {
  const f = fixture([]);
  for (const status of ["running", "ready"]) {
    assert.equal(f.host.tabSnapshot(ready({ status })).startupPreparation, true);
  }
  assert.equal(f.host.tabSnapshot(ready({ startupPreparation: false })).startupPreparation, undefined);
});

test("a draining continuation does not re-enable speculative startup", async () => {
  const f = fixture([]);
  f.host.startupPreparationAllowed = false;
  await f.host.beginTurn("continuation", false, process.pid, true, undefined, "Codex Native2",
    false, undefined, { allowed: false });
  assert.equal(f.host.startupPreparationAllowed, false);
  await assert.rejects(f.host.beginTurn("startup_next", false, process.pid, true, undefined, "Codex Native2",
    false, undefined, { preparing: true }), /capacity|disabled/);
});

test("only a running authenticated preparation can become ready", () => {
  for (const extra of [{ status: "failed" }, { status: "ready" }, { bootstrapReady: false },
    { interactionMode: "manual" }, { authenticationRequired: true }]) {
    const warm = ready({ status: "running", ...extra }), f = fixture([warm]);
    assert.throws(() => f.host.markStartupPrepared(warm.traceId, process.pid));
  }
});
