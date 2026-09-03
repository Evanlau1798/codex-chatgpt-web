const test = require("node:test");
const assert = require("node:assert/strict");
const { BrowserHost } = require("../electron/browser-host.cjs");
const { ManualTurnController } = require("../electron/manual-turn-controller.cjs");

function fixture(tab) {
  const host = {
    lastTurnSweepAt: 180_000,
    turnTabs: new Map([[tab.id, tab]]),
    logger: { info() {}, warn() {} },
    removeTurnTab(value) { this.turnTabs.delete(value.id); },
  };
  host.manualTurns = new ManualTurnController({ host, logger: host.logger, clipboard: {} });
  return host;
}

for (const bootstrapReady of [true, false]) test(`manual live owner ignores automatic expiry (bootstrap=${bootstrapReady})`, () => {
  const host = fixture({ id: "manual", traceId: "manual-trace", interactionMode: "manual",
    status: "running", helperPid: process.pid, bootstrapReady, bootstrapDeadlineAt: 1, lastHeartbeatAt: 1 });
  BrowserHost.prototype.reapExpiredTurnTabs.call(host, 181_000);
  assert.equal(host.turnTabs.size, 1);
});

test("manual owner death fails waiters and removes only its surface", async () => {
  const tab = { id: "dead", traceId: "dead-trace", interactionMode: "manual", status: "running",
    helperPid: -1, bootstrapReady: true, lastHeartbeatAt: 180_000,
    manualWaiters: new Set(), manualTerminalWaiters: new Set() };
  const host = fixture(tab);
  const sent = host.manualTurns.waitSent(tab.traceId, tab.helperPid);
  const terminal = host.manualTurns.waitTerminal(tab.traceId, tab.helperPid);
  BrowserHost.prototype.reapExpiredTurnTabs.call(host, 181_000);
  assert.equal(host.turnTabs.size, 0);
  assert.deepEqual(await sent, { status: "failed" });
  assert.deepEqual(await terminal, { status: "failed" });
});

test("manual ready surfaces still expire by retained TTL", () => {
  const host = fixture({ id: "ready", traceId: "ready-trace", interactionMode: "manual",
    status: "ready", helperPid: process.pid, lastHeartbeatAt: 0 });
  host.lastTurnSweepAt = 1_800_000;
  BrowserHost.prototype.reapExpiredTurnTabs.call(host, 1_801_000);
  assert.equal(host.turnTabs.size, 0);
});
