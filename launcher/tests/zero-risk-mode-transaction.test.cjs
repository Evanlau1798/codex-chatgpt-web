const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { BrowserHost } = require("../electron/browser-host.cjs");
const { BrowserControlServer } = require("../electron/control-server.cjs");
const { ManualTurnController } = require("../electron/manual-turn-controller.cjs");

function hostFixture() {
  const removed = [];
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    getBrowserInteractionMode: () => "manual", manualOperation: null,
    turnTabs: new Map([["retained", { id: "retained", status: "ready", interactionMode: "manual" }]]),
    selectedTabId: "retained", snapshot: () => ({ activeTabId: "home" }),
    removeTurnTab(tab, abort) { assert.equal(abort, false); removed.push(tab.id); this.turnTabs.delete(tab.id); },
  });
  return { host, removed };
}

test("interaction-mode changes preserve retained tabs on failure and isolate them after commit", async () => {
  const { host, removed } = hostFixture();
  host.turnTabs.set("automatic", { id: "automatic", status: "ready", interactionMode: "automatic" });
  await assert.rejects(async () => host.withInteractionModeChange("automatic", async () => {
    assert.equal(host.currentOperation(), "browser interaction mode change");
    assert.equal(host.browserInteractionMode(), "automatic");
    throw new Error("fixture setup failure");
  }), /fixture setup failure/);
  assert.deepEqual(removed, []);
  assert.equal(host.turnTabs.size, 2);
  assert.equal(host.currentOperation(), null);
  assert.equal(host.browserInteractionMode(), "manual");
  assert.equal(await host.withInteractionModeChange("automatic", async () => "configured"), "configured");
  assert.deepEqual(removed, ["retained", "automatic"]);
  assert.equal(host.turnTabs.size, 0);
  assert.equal(host.selectedTabId, "home");
  assert.equal(host.currentOperation(), null);
  assert.equal(host.browserInteractionMode(), "manual");
});

test("interaction transaction refuses invalid modes, live turns and overlapping operations before setup", async () => {
  for (const kind of ["invalid", "live", "busy"]) {
    const { host } = hostFixture();
    if (kind === "live") host.turnTabs.get("retained").status = "running";
    if (kind === "busy") host.manualOperation = "fixture login";
    let actions = 0;
    await assert.rejects(async () => host.withInteractionModeChange(kind === "invalid" ? "other" : "automatic", async () => { actions++; }),
      kind === "invalid" ? /must be automatic or manual/ : kind === "live" ? /Finish or cancel active/ : /already busy/);
    assert.equal(actions, 0);
    assert.equal(host.turnTabs.size, 1);
  }
});

test("manual-to-automatic transaction exposes capability inspection and preserves tabs on rollback", async () => {
  const { host, removed } = hostFixture();
  let inspections = 0;
  host.runSessionInspection = async enabled => {
    assert.equal(enabled, true);
    assert.equal(host.browserInteractionMode(), "automatic");
    inspections++;
    return { authenticated: true, temporary: true, url: "https://example.invalid" };
  };
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} }, getBrowserHost: () => host,
    getPreferences: () => ({ browserInteractionMode: "manual" }),
  }).start();
  const descriptor = server.descriptor();
  const inspect = () => fetch(`${descriptor.endpoint}/v1/session/inspect`, {
    method: "POST", headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
    body: JSON.stringify({ detectCapabilities: true }),
  });
  try {
    assert.notEqual((await inspect()).status, 200);
    await assert.rejects(async () => host.withInteractionModeChange("automatic", async () => {
      assert.equal((await inspect()).status, 200);
      assert.equal(host.turnTabs.size, 1);
      throw new Error("fixture setup failure");
    }), /fixture setup failure/);
    assert.equal(host.browserInteractionMode(), "manual");
    assert.deepEqual(removed, []);
    await host.withInteractionModeChange("automatic", async () => assert.equal((await inspect()).status, 200));
    assert.deepEqual(removed, ["retained"]);
    assert.equal(inspections, 2);
    assert.notEqual((await inspect()).status, 200);
  } finally { await server.close(); }
});

test("pending mode setup rejects manual starts before copying or allocating a surface", () => {
  const { host } = hostFixture();
  host.manualOperation = "browser interaction mode change";
  let copies = 0;
  host.manualTurns = new ManualTurnController({ host, clipboard: { writeText() { copies++; } }, logger: {} });
  assert.throws(() => host.beginManualTurn("fixture-trace", process.pid, "fixture prompt"), /busy/);
  assert.equal(copies, 0);
  assert.equal(host.turnTabs.size, 1);
});

function ipc(name, context) {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const start = source.indexOf(`  handle("launcher:${name}",`);
  const end = source.indexOf("\n  });", start);
  assert.ok(start >= 0 && end > start);
  let handler;
  vm.runInNewContext(source.slice(start, end + 6), {
    IS_DEV_PROFILE: false, send() {}, logger: {}, startCatalogVerificationMonitor() {},
    ...context, handle: (_name, callback) => { handler = callback; },
  });
  return handler;
}

for (const entry of ["browser-interaction-mode", "setup-mcp"]) {
  test(`${entry} IPC executes setup inside the actual BrowserHost transaction`, async () => {
    const { host, removed } = hostFixture();
    let state = { browserInteractionMode: "manual", experimentalBiggerContext: false };
    host.getBrowserInteractionMode = () => state.browserInteractionMode;
    host.reveal = async () => { throw new Error("mode transition must not reveal before transaction"); };
    const setup = async () => {
      assert.equal(host.browserInteractionMode(), "automatic");
      assert.equal(host.currentOperation(), "browser interaction mode change");
      assert.equal(host.turnTabs.size, 1);
      return { configured: true, stdout: "fixture configured" };
    };
    const handler = ipc(entry, {
      browserHost: host, runtimeHost: {
        mcpCredentialsConfigured: () => true, setBrowserInteractionMode: setup, setupMcp: setup,
        runtimeConfigSnapshot: () => ({ config: {} }),
      },
      stateStore: { read: () => state, update: patch => Object.assign(state, patch) },
    });
    await handler({}, entry === "setup-mcp" ? { interactionMode: "automatic" } : "automatic");
    assert.equal(state.browserInteractionMode, "automatic");
    assert.deepEqual(removed, ["retained"]);
  });
}

for (const entry of ["zero-risk-pro", "browser-interaction-mode"]) {
  test(`${entry} IPC rejects active browser work before changing runtime preferences`, async () => {
    for (const live of [true, false]) {
      let called = false;
      const change = async () => { called = true; return { enabled: true }; };
      const handler = ipc(entry, {
        browserHost: { activeTraceId: live ? "fixture-running" : null, currentOperation: () => live ? null : "fixture operation" },
        runtimeHost: { setZeroRiskPro: change, setBrowserInteractionMode: change, mcpCredentialsConfigured: () => true },
        stateStore: { read: () => ({ browserInteractionMode: "manual" }), update: value => value },
      });
      await assert.rejects(handler({}, entry === "zero-risk-pro" ? true : "automatic"), /Finish/);
      assert.equal(called, false);
    }
  });
}

test("mode IPC asks for the target credentials without mutating browser or runtime", async () => {
  const { host, removed } = hostFixture();
  const requested = [];
  const state = { browserInteractionMode: "manual" };
  const handler = ipc("browser-interaction-mode", {
    browserHost: host, stateStore: { read: () => state },
    runtimeHost: { mcpCredentialsConfigured: mode => { requested.push(mode); return false; } },
  });
  const result = await handler({}, "automatic");
  assert.equal(result.credentialsRequired, true);
  assert.equal(result.targetMode, "automatic");
  assert.deepEqual(requested, ["automatic"]);
  assert.deepEqual(removed, []);
});

test("MCP setup rejects an explicit invalid mode before any browser or runtime work", async () => {
  const handler = ipc("setup-mcp", {
    browserHost: {}, runtimeHost: {}, stateStore: { read: () => ({ browserInteractionMode: "manual" }) },
  });
  await assert.rejects(handler({}, { interactionMode: "other" }), /Browser interaction mode is invalid/);
});
