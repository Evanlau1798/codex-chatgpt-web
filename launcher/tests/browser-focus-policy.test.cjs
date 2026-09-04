const assert = require("node:assert/strict");
const test = require("node:test");
const { BrowserHost } = require("../electron/browser-host.cjs");

test("automated browser visibility never activates the launcher window", () => {
  const events = [];
  const fixture = {
    window: {
      isMinimized: () => true,
      isVisible: () => false,
      restore: () => events.push("restore"),
      show: () => events.push("show"),
      showInactive: () => events.push("showInactive"),
    },
    visible: false,
    surfaceActive: true,
    boundsReady: true,
    activeView: () => ({ webContents: { focus: () => events.push("focus") } }),
    syncViewVisibility: () => events.push("visibility"),
    setState: () => events.push("state"),
  };

  BrowserHost.prototype.show.call(fixture, { activate: false });

  assert.deepEqual(events, ["showInactive", "visibility", "state"]);
  assert.equal(fixture.visible, true);
});

test("manual browser reveal preserves explicit activation", () => {
  const events = [];
  const fixture = {
    window: {
      isMinimized: () => true,
      isVisible: () => false,
      restore: () => events.push("restore"),
      show: () => events.push("show"),
      showInactive: () => events.push("showInactive"),
    },
    visible: false,
    surfaceActive: true,
    boundsReady: true,
    activeView: () => ({ webContents: { focus: () => events.push("focus") } }),
    syncViewVisibility: () => events.push("visibility"),
    setState: () => events.push("state"),
  };

  BrowserHost.prototype.show.call(fixture);

  assert.deepEqual(events, ["restore", "show", "visibility", "state", "focus"]);
});

test("turn acquisition requests non-activating visibility", async () => {
  const showOptions = [];
  const tab = { id: "tab-1", surfaceId: "surface-1" };
  const fixture = {
    manualOperation: null,
    turnTabs: new Map(),
    userCancelledTurnOwners: new Map(),
    createTurnTab: () => tab,
    show: (options) => showOptions.push(options),
    syncViewVisibility() {},
    publishState() {},
    snapshot: () => ({}),
    logger: { info() {} },
  };

  const lease = await BrowserHost.prototype.beginTurn.call(fixture, "trace-1", true, 1234);

  assert.deepEqual(showOptions, [{ activate: false }]);
  assert.deepEqual(lease, { surfaceId: "surface-1", tabId: "tab-1", reused: false });
});
