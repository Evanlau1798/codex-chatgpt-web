const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setRuntimeBooleanSetting } = require("../electron/runtime-boolean-setting.cjs");
const { BrowserHost } = require("../electron/browser-host.cjs");
const { createStateStore } = require("../electron/state.cjs");

test("missing launcher state enables Enhanced output tunneling", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwg-output-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(createStateStore(path.join(root, "state.json")).read().useEnhancedOutputTunnel, true);
});

test("output tunnel changes restart transactionally and release retained tabs", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwg-output-setting-"));
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ useEnhancedOutputTunnel: true }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  let releases = 0;
  const host = {
    lifecycleOperation: null,
    currentOperation: () => null,
    runtimeConfigSnapshot: () => ({
      configured: true, owner: "launcher", config: JSON.parse(fs.readFileSync(configPath, "utf8")),
    }),
    supervisor: {
      configPath,
      stopForSetup: async (options) => { calls.push(["stop", options]); },
      startIfConfigured: async () => { calls.push("start"); return { status: "ready" }; },
    },
    browserHostProvider: () => ({ releaseRetainedTurnTabs: (mode) => { assert.equal(mode, "automatic"); releases += 1; } }),
  };
  assert.equal(await setRuntimeBooleanSetting(host, "useEnhancedOutputTunnel", false, {
    name: "output-change", label: "output tunneling",
  }), false);
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).useEnhancedOutputTunnel, false);
  assert.deepEqual(calls, [["stop", { browserOnly: true }], "start"]);
  assert.equal(releases, 1);
});

test("output tunnel changes release only Automatic retained tabs", () => {
  const removed = [];
  const host = {
    turnTabs: new Map([
      ["automatic", { id: "automatic", status: "ready", interactionMode: "automatic" }],
      ["manual", { id: "manual", status: "ready", interactionMode: "manual" }],
      ["running", { id: "running", status: "running", interactionMode: "automatic" }],
    ]),
    removeTurnTab(tab) {
      removed.push(tab.id);
      this.turnTabs.delete(tab.id);
    },
  };
  assert.equal(BrowserHost.prototype.releaseRetainedTurnTabs.call(host, "automatic"), 1);
  assert.deepEqual(removed, ["automatic"]);
  assert.deepEqual([...host.turnTabs.keys()], ["manual", "running"]);
});

test("output tunnel changes restore the previous runtime after restart failure", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwg-output-setting-rollback-"));
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ useEnhancedOutputTunnel: true }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let starts = 0;
  let releases = 0;
  const host = {
    lifecycleOperation: null,
    currentOperation: () => null,
    runtimeConfigSnapshot: () => ({
      configured: true, owner: "launcher", config: JSON.parse(fs.readFileSync(configPath, "utf8")),
    }),
    supervisor: {
      configPath,
      stopForSetup: async () => {},
      startIfConfigured: async () => ({ status: ++starts === 1 ? "error" : "ready" }),
    },
    browserHostProvider: () => ({ releaseRetainedTurnTabs: () => { releases += 1; } }),
  };
  await assert.rejects(setRuntimeBooleanSetting(host, "useEnhancedOutputTunnel", false, {
    name: "output-change", label: "output tunneling",
  }), /Local runtime is error/);
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).useEnhancedOutputTunnel, true);
  assert.equal(starts, 2);
  assert.equal(releases, 0);
  assert.equal(host.lifecycleOperation, null);
});

test("retained-tab cleanup failure does not roll back a running updated runtime", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwg-output-setting-cleanup-"));
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ useEnhancedOutputTunnel: true }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let starts = 0;
  const host = {
    lifecycleOperation: null,
    currentOperation: () => null,
    runtimeConfigSnapshot: () => ({
      configured: true, owner: "launcher", config: JSON.parse(fs.readFileSync(configPath, "utf8")),
    }),
    supervisor: {
      configPath,
      stopForSetup: async () => {},
      startIfConfigured: async () => { starts += 1; return { status: "ready" }; },
    },
    browserHostProvider: () => ({ releaseRetainedTurnTabs: () => { throw new Error("descriptor cleanup failed"); } }),
  };
  assert.equal(await setRuntimeBooleanSetting(host, "useEnhancedOutputTunnel", false, {
    name: "output-change", label: "output tunneling",
  }), false);
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).useEnhancedOutputTunnel, false);
  assert.equal(starts, 1);
  assert.equal(host.lifecycleOperation, null);
});

test("launcher exposes the Enhanced output toggle only in its effective modes", () => {
  const root = path.join(__dirname, "..");
  const settings = fs.readFileSync(path.join(root, "src", "settings-surface.tsx"), "utf8");
  const types = fs.readFileSync(path.join(root, "src", "types.ts"), "utf8");
  const main = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(root, "electron", "preload.cjs"), "utf8");
  assert.match(types, /useEnhancedOutputTunnel: boolean/);
  assert.match(types, /setUseEnhancedOutputTunnel\(enabled: boolean\)/);
  assert.match(settings, /checked=\{snapshot\.state\.useEnhancedOutputTunnel\}/);
  assert.match(settings, /!snapshot\.state\.useEnhancedWebSessionMode \|\| snapshot\.state\.browserInteractionMode !== "automatic"/);
  assert.match(main, /launcher:enhanced-output-tunnel/);
  assert.match(preload, /setUseEnhancedOutputTunnel: \(enabled\).*launcher:enhanced-output-tunnel/);
});
