const test = require("node:test");
const assert = require("node:assert/strict");
const { BrowserHost } = require("../electron/browser-host.cjs");

test("a reconnect heartbeat marks only its owned hidden viewport for refresh", () => {
  const tab = {
    traceId: "trace_refresh",
    helperPid: 42,
    status: "running",
    lastHeartbeatAt: 0,
    deviceEmulationDirty: false,
  };
  let synchronized = 0;
  const fixture = {
    turnTabs: new Map([["tab", tab]]),
    closedTurnOwners: new Map(),
    syncViewVisibility: () => { synchronized += 1; },
    snapshot: () => ({ ok: true }),
  };

  assert.deepEqual(BrowserHost.prototype.heartbeatTurn.call(
    fixture,
    tab.traceId,
    tab.helperPid,
    true,
  ), { ok: true });
  assert.equal(tab.deviceEmulationDirty, true);
  assert.equal(synchronized, 1);
  assert.throws(
    () => BrowserHost.prototype.heartbeatTurn.call(fixture, tab.traceId, tab.helperPid, "yes"),
    /refreshViewport is invalid/,
  );
});
