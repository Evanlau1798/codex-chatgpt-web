const assert = require("node:assert/strict");
const test = require("node:test");
const { BrowserHost } = require("../electron/browser-host.cjs");

function retainedTurnFixture() {
  const tab = {
    id: "tab-1",
    traceId: "trace-1",
    helperPid: 1234,
    status: "running",
    connectorIdentity: "Codex Native2",
    connectorBound: false,
    view: {
      webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling() {},
      },
    },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]),
    userCancelledTurnOwners: new Map(),
    snapshot: () => ({ tabs: [] }),
    publishState() {},
    writeDescriptor() {},
    logger: { info() {} },
  });
  return { fixture, tab };
}

test("retained completed turns preserve the turn-end acknowledgement contract", async () => {
  const { fixture, tab } = retainedTurnFixture();

  const result = await BrowserHost.prototype.endTurn.call(
    fixture,
    tab.traceId,
    tab.helperPid,
    "completed",
    false,
    undefined,
    true,
    true,
  );

  assert.deepEqual(result, { cancelledByUser: false });
  assert.equal(fixture.turnTabs.get(tab.id), tab);
  assert.equal(tab.status, "ready");
  assert.equal(tab.connectorBound, true);
});

test("a retired startup page acknowledges its same-owner end retry without touching another turn", async () => {
  const { fixture, tab } = retainedTurnFixture();
  tab.startupPreparation = true;
  const other = { ...tab, id: "other-tab", traceId: "other-trace", helperPid: 5678 };
  fixture.turnTabs.set(other.id, other);
  fixture.closedTurnOwners = new Map();
  fixture.removeTurnTab = removed => { fixture.turnTabs.delete(removed.id); };

  assert.deepEqual(await fixture.endTurn(tab.traceId, tab.helperPid, "aborted", false),
    { cancelledByUser: false });
  assert.equal(fixture.turnTabs.get(other.id), other);
  await assert.rejects(fixture.endTurn(tab.traceId, other.helperPid, "aborted", false), /ownership mismatch/);
  assert.deepEqual(await fixture.endTurn(tab.traceId, tab.helperPid, "aborted", false),
    { cancelledByUser: false });
  assert.equal(fixture.turnTabs.get(other.id), other);
  await assert.rejects(fixture.endTurn(tab.traceId, tab.helperPid, "aborted", false), /ownership mismatch/);
});

test("unconsumed startup retirement acknowledgements are bounded", async () => {
  const { fixture, tab } = retainedTurnFixture();
  tab.startupPreparation = true;
  fixture.closedTurnOwners = new Map(Array.from({ length: 256 }, (_, i) => [`old-${i}`, { helperPid: tab.helperPid, remainingAcks: 1 }]));
  fixture.removeTurnTab = removed => { fixture.turnTabs.delete(removed.id); };
  await fixture.endTurn(tab.traceId, tab.helperPid, "aborted", false);
  assert.deepEqual(fixture.closedTurnOwners.get(tab.traceId), { helperPid: tab.helperPid, remainingAcks: 1 });
  assert.equal(fixture.closedTurnOwners.size, 256);
  assert.equal(fixture.closedTurnOwners.has("old-0"), false);
});

test("discarding standby pages bounds retirement receipts through the real removal path", () => {
  const { fixture, tab } = retainedTurnFixture();
  tab.startupPreparation = true;
  fixture.closedTurnOwners = new Map(Array.from({ length: 256 }, (_, i) => [`old-${i}`, { helperPid: tab.helperPid, remainingAcks: 1 }]));
  Object.assign(fixture, { syncPowerSaveBlocker() {}, syncViewVisibility() {},
    window: { contentView: { removeChildView() {} } } });
  tab.view.webContents.close = () => {};
  fixture.discardStartupPages();
  assert.deepEqual(fixture.closedTurnOwners.get(tab.traceId), { helperPid: tab.helperPid, remainingAcks: 2 });
  assert.equal(fixture.closedTurnOwners.size, 256);
  assert.equal(fixture.closedTurnOwners.has("old-0"), false);
});

test("external standby removal retains the original end plus one lost-response retry", async () => {
  const { fixture, tab } = retainedTurnFixture();
  tab.startupPreparation = true;
  Object.assign(fixture, { closedTurnOwners: new Map(), syncPowerSaveBlocker() {}, syncViewVisibility() {},
    window: { contentView: { removeChildView() {} } } });
  tab.view.webContents.close = () => {};
  fixture.discardStartupPages();
  await assert.rejects(fixture.endTurn(tab.traceId, 5678, "aborted", false), /ownership mismatch/);
  assert.deepEqual(await fixture.endTurn(tab.traceId, tab.helperPid, "aborted", false), { cancelledByUser: false });
  await assert.rejects(fixture.endTurn(tab.traceId, 5678, "aborted", false), /ownership mismatch/);
  assert.deepEqual(await fixture.endTurn(tab.traceId, tab.helperPid, "aborted", false), { cancelledByUser: false });
  await assert.rejects(fixture.endTurn(tab.traceId, tab.helperPid, "aborted", false), /ownership mismatch/);
});
