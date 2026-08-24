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
