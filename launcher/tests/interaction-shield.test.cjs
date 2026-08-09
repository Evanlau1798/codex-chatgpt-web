const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { BrowserHost } = require("../electron/browser-host.cjs");

const source = readFileSync(path.join(__dirname, "..", "electron", "browser-host.cjs"), "utf8");

test("turn interaction shielding stays outside the ChatGPT DOM", () => {
  assert.doesNotMatch(source, /codex-web-gpt-interaction-shield/);
  assert.match(source, /TURN_INTERACTION_SHIELD_URL/);
  assert.match(source, /interactionShield/);
  assert.ok(source.indexOf("addChildView(view)") < source.indexOf("addChildView(interactionShield)"));
});

test("turn visibility keeps the native shield above its ChatGPT view", () => {
  const calls = [];
  const tab = {
    id: "turn",
    view: { setVisible: value => calls.push(["turn", value]) },
    interactionShield: { setVisible: value => calls.push(["shield", value]) },
  };
  const fixture = {
    visible: true,
    surfaceActive: true,
    boundsReady: true,
    view: { setVisible: value => calls.push(["home", value]) },
    turnTabs: new Map([[tab.id, tab]]),
    selectedTurnTab: () => tab,
  };

  BrowserHost.prototype.syncViewVisibility.call(fixture);

  assert.deepEqual(calls, [["home", false], ["turn", true], ["shield", true]]);
});

test("the native shield owns operating-system focus for a selected turn", () => {
  const focused = [];
  const tab = {
    view: { webContents: { focus: () => focused.push("turn") } },
    interactionShield: { webContents: { isDestroyed: () => false, focus: () => focused.push("shield") } },
  };
  const fixture = {
    selectedTurnTab: () => tab,
    activeView: () => tab.view,
  };

  BrowserHost.prototype.focusActiveSurface.call(fixture);

  assert.deepEqual(focused, ["shield"]);
});

test("removing a turn closes both its ChatGPT view and native shield", () => {
  const removed = [];
  const closed = [];
  const view = { webContents: { isDestroyed: () => false, close: () => closed.push("turn") } };
  const interactionShield = { webContents: { isDestroyed: () => false, close: () => closed.push("shield") } };
  const tab = { id: "turn", traceId: "trace", helperPid: 123, status: "ready", view, interactionShield };
  const fixture = {
    window: { contentView: { removeChildView: child => removed.push(child) } },
    turnTabs: new Map([[tab.id, tab]]),
    closedTurnOwners: new Map(),
    selectedTabId: "home",
    syncViewVisibility() {},
    publishState() {},
    snapshot: () => ({}),
    writeDescriptor() {},
  };

  BrowserHost.prototype.removeTurnTab.call(fixture, tab, false);

  assert.deepEqual(removed, [interactionShield, view]);
  assert.deepEqual(closed, ["shield", "turn"]);
});
