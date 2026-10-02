const test = require("node:test");
const assert = require("node:assert/strict");
const { BrowserHost } = require("../electron/browser-host.cjs");

function fixture() {
  const visibility = new Map();
  const focus = [];
  const tab = id => ({ id, traceId: `trace-${id}`, helperPid: process.pid, status: "running",
    interactionMode: "automatic", interactionLocked: true,
    view: { webContents: { isDestroyed: () => false, focus: () => focus.push(`page-${id}`) } },
    interactionShield: { setVisible: shown => visibility.set(id, shown),
      webContents: { isDestroyed: () => false, focus: () => focus.push(`shield-${id}`) } },
  });
  const selected = tab("selected");
  const other = tab("other");
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[selected.id, selected], [other.id, other]]), closedTurnOwners: new Map(),
    selectedTabId: selected.id, visible: true, surfaceActive: true, boundsReady: true,
    window: { isVisible: () => true, isMinimized: () => false },
    presentPrimaryView() {}, presentTurnView() {}, snapshot: () => ({}),
  });
  return { host, selected, other, visibility, focus };
}

test("pending approval permits the selected browser UI and restores its configured shield", () => {
  const { host, selected, other, visibility, focus } = fixture();
  host.syncViewVisibility();
  assert.equal(visibility.get(selected.id), true);
  host.setTurnApprovalPending(selected.traceId, selected.helperPid, true);
  assert.equal(visibility.get(selected.id), false);
  assert.equal(selected.interactionLocked, true, "approval must not mutate the configured protection");
  assert.equal(other.approvalPending, undefined);
  host.setInteractionLocked(true);
  assert.equal(visibility.get(selected.id), false);
  host.focusActiveSurface();
  assert.equal(focus.at(-1), "page-selected");
  host.setTurnApprovalPending(selected.traceId, selected.helperPid, false);
  assert.equal(visibility.get(selected.id), true);
  host.focusActiveSurface();
  assert.equal(focus.at(-1), "shield-selected");
  assert.throws(() => host.setTurnApprovalPending(selected.traceId, selected.helperPid + 1, true), /ownership mismatch/);
  assert.equal(visibility.get(selected.id), true);
});

test("a ready Fast startup page cannot become an approval surface", () => {
  const { host, selected } = fixture();
  selected.status = "ready";
  selected.startupPreparation = true;
  assert.throws(() => host.setTurnApprovalPending(selected.traceId, selected.helperPid, true), /running/);
  assert.equal(selected.approvalPending, undefined);
});
