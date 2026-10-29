const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { BrowserHost } = require("../electron/browser-host.cjs");
const { ManualTurnController } = require("../electron/manual-turn-controller.cjs");

test("visibility synchronization never touches native views after host or window teardown", () => {
  for (const hostDestroyed of [false, true]) {
    const host = Object.assign(Object.create(BrowserHost.prototype), {
      destroyed: hostDestroyed,
      window: {
        isDestroyed: () => !hostDestroyed,
        isVisible() { throw new TypeError("Object has been destroyed"); },
      },
      presentPrimaryView() { assert.fail("must not present a destroyed window"); },
    });
    assert.doesNotThrow(() => host.syncViewVisibility());
  }
});

test("window teardown still retires external turn ownership, manual waiters and descriptors once", () => {
  for (const scenario of ["automatic", "manual", "manual-cancel"]) {
    const interactionMode = scenario === "automatic" ? "automatic" : "manual";
    const status = scenario === "manual-cancel" ? "cancelled" : "failed";
    const contents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler() {}, isDestroyed: () => true,
    });
    const terminal = [], published = [], descriptors = [];
    const tab = { id: "closed", traceId: "trace", helperPid: 77, status: "running", interactionMode,
      view: { webContents: contents }, manualWaiters: new Set([value => terminal.push(value)]),
      manualTerminalWaiters: new Set([value => terminal.push(value)]),
      manualTimer: setTimeout(() => assert.fail("manual timer survived teardown"), 60_000),
      prompt: "private prompt", promptDigest: "digest",
    };
    const host = Object.assign(Object.create(BrowserHost.prototype), {
      window: { isDestroyed: () => true,
        isVisible() { throw new TypeError("Object has been destroyed"); },
        contentView: { removeChildView() {} },
      },
      turnTabs: new Map([[tab.id, tab]]), closedTurnOwners: new Map(), selectedTabId: tab.id,
      logger: { warn() {} }, syncPowerSaveBlocker() {},
      snapshot() { return { ids: [...this.turnTabs.keys()] }; },
      publishState: state => published.push(state),
      writeDescriptor() { descriptors.push([...this.turnTabs.keys()]); },
    });
    host.manualTurns = new ManualTurnController({ host, logger: host.logger });
    host.bindTurnContents(tab);
    try {
      assert.doesNotThrow(() => scenario === "manual-cancel"
        ? host.manualTurns.cancel(tab.traceId, tab.helperPid) : contents.emit("destroyed"));
      assert.equal(host.turnTabs.size, 0);
      assert.equal(host.selectedTabId, "home");
      assert.equal(tab.status, "aborted");
      assert.deepEqual(host.closedTurnOwners.get(tab.traceId), { helperPid: 77, remainingAcks: 2 });
      assert.deepEqual(published, [{ ids: [] }]);
      assert.deepEqual(descriptors, [[]]);
      assert.deepEqual(terminal, interactionMode === "manual" ? [{ status }, { status }] : []);
      if (interactionMode === "manual") {
        assert.equal(tab.manualTimer, null);
        assert.equal(tab.prompt, null);
        assert.equal(tab.promptDigest, null);
      }
      contents.emit("destroyed");
      assert.equal(descriptors.length, 1);
    } finally { clearTimeout(tab.manualTimer); }
  }
});
