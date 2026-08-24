const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RuntimeHost } = require("../electron/runtime.cjs");
const { validateConfig } = require("../electron/runtime-supervisor.cjs");

function configFor(descriptorPath, overrides = {}) {
  const root = path.dirname(descriptorPath);
  return {
    version: 3,
    releaseVersion: "2.1.1",
    mode: "browser-only",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native2",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    chromeExecutablePath: process.execPath,
    storageStatePath: path.join(root, "storage-state.json"),
    brokerSocketPath: process.platform === "win32"
      ? "\\\\.\\pipe\\codex-chatgpt-web-new-compact-test"
      : path.join(root, "turn-broker.sock"),
    headed: true,
    solAvailable: true,
    proAvailable: true,
    autoApproveToolCalls: false,
    controlToken: "new-compact-mode-control-token-0123456789abcdef",
    runtimeCommand: [process.execPath],
    ...overrides,
  };
}

function compactFixture({ startResults = [{ status: "ready" }], enhanced } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-new-compact-"));
  const descriptorPath = path.join(root, "launcher-browser.json");
  const configPath = path.join(root, "config.json");
  const mode = typeof enhanced === "boolean" ? { useEnhancedWebSessionMode: enhanced } : {};
  fs.writeFileSync(configPath, `${JSON.stringify(configFor(descriptorPath, mode), null, 2)}\n`);
  const calls = [];
  let startIndex = 0;
  let retainedReleases = 0;
  const read = () => validateConfig(JSON.parse(fs.readFileSync(configPath, "utf8")), descriptorPath);
  const supervisor = {
    configPath,
    readConfig: read,
    readSetupConfig: read,
    stopForSetup: async () => { calls.push("stop"); return { status: "stopped" }; },
    startIfConfigured: async () => {
      calls.push("start");
      return startResults[Math.min(startIndex++, startResults.length - 1)];
    },
  };
  const host = new RuntimeHost({
    app: { getPath: () => root },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    browserDescriptorPath: descriptorPath,
    supervisor,
    browserHostProvider: () => ({ releaseRetainedTurnTabs: () => { retainedReleases += 1; } }),
  });
  return { calls, configPath, host, root, retainedReleases: () => retainedReleases };
}

test("launcher keeps a missing legacy runtime mode disabled", () => {
  const descriptorPath = path.join(os.tmpdir(), "launcher-browser.json");
  const config = validateConfig(configFor(descriptorPath), descriptorPath);
  assert.equal(config.useEnhancedWebSessionMode, false);
  assert.throws(
    () => validateConfig(configFor(descriptorPath, { useEnhancedWebSessionMode: "yes" }), descriptorPath),
    /invalid useEnhancedWebSessionMode/,
  );
});

test("launcher migrates the legacy compact key and rejects conflicting mode keys", () => {
  const descriptorPath = path.join(os.tmpdir(), "launcher-browser.json");
  const migrated = validateConfig(configFor(descriptorPath, { useNewCompactMode: true }), descriptorPath);
  assert.equal(migrated.useEnhancedWebSessionMode, true);
  assert.equal(migrated.useNewCompactMode, undefined);
  assert.throws(
    () => validateConfig(configFor(descriptorPath, {
      useNewCompactMode: true,
      useEnhancedWebSessionMode: false,
    }), descriptorPath),
    /conflicting Web session mode settings/,
  );
});

test("launcher atomically changes enhanced Web session mode and restarts the configured runtime", async (t) => {
  const fixture = compactFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(await fixture.host.setUseEnhancedWebSessionMode(true), true);
  assert.equal(JSON.parse(fs.readFileSync(fixture.configPath, "utf8")).useEnhancedWebSessionMode, true);
  assert.deepEqual(fixture.calls, ["stop", "start"]);

  assert.equal(await fixture.host.setUseEnhancedWebSessionMode(true), true);
  assert.deepEqual(fixture.calls, ["stop", "start"]);
});

test("launcher restores the prior enhanced mode when runtime restart fails", async (t) => {
  const fixture = compactFixture({
    startResults: [{ status: "error", detail: "synthetic startup failure" }, { status: "ready" }],
  });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  await assert.rejects(
    fixture.host.setUseEnhancedWebSessionMode(true),
    /synthetic startup failure/,
  );
  assert.equal(JSON.parse(fs.readFileSync(fixture.configPath, "utf8")).useEnhancedWebSessionMode, undefined);
  assert.deepEqual(fixture.calls, ["stop", "start", "start"]);
});

test("disabling enhanced mode releases only completed retained browser sessions", async (t) => {
  const fixture = compactFixture({ enhanced: true });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(await fixture.host.setUseEnhancedWebSessionMode(false), false);
  assert.equal(fixture.retainedReleases(), 1);
  assert.deepEqual(fixture.calls, ["stop", "start"]);
});

test("launcher exposes enhanced Web session mode through UI and IPC", () => {
  const root = path.join(__dirname, "..");
  const app = fs.readFileSync(path.join(root, "src", "App.tsx"), "utf8");
  const types = fs.readFileSync(path.join(root, "src", "types.ts"), "utf8");
  const i18n = fs.readFileSync(path.join(root, "src", "i18n.ts"), "utf8");
  const main = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(root, "electron", "preload.cjs"), "utf8");

  assert.match(types, /useEnhancedWebSessionMode: boolean/);
  assert.match(types, /setUseEnhancedWebSessionMode\(enabled: boolean\)/);
  assert.match(i18n, /Enhanced Web session mode \(Beta\)/);
  assert.match(i18n, /增強型 Web 工作階段模式（Beta）/);
  assert.match(app, /checked=\{snapshot\.state\.useEnhancedWebSessionMode\}/);
  assert.match(app, /api!\.setUseEnhancedWebSessionMode\(enabled\)/);
  assert.match(main, /launcher:enhanced-web-session-mode/);
  assert.match(main, /runtimeHost\.setUseEnhancedWebSessionMode\(enabled === true\)/);
  assert.match(preload, /setUseEnhancedWebSessionMode: \(enabled\).*launcher:enhanced-web-session-mode/);
});
