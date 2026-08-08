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

function compactFixture({ startResults = [{ status: "ready" }] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-new-compact-"));
  const descriptorPath = path.join(root, "launcher-browser.json");
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, `${JSON.stringify(configFor(descriptorPath), null, 2)}\n`);
  const calls = [];
  let startIndex = 0;
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
  });
  return { calls, configPath, host, root };
}

test("launcher runtime config defaults the Beta compact mode off", () => {
  const descriptorPath = path.join(os.tmpdir(), "launcher-browser.json");
  const config = validateConfig(configFor(descriptorPath), descriptorPath);
  assert.equal(config.useNewCompactMode, false);
  assert.throws(
    () => validateConfig(configFor(descriptorPath, { useNewCompactMode: "yes" }), descriptorPath),
    /invalid useNewCompactMode/,
  );
});

test("launcher atomically changes compact mode and restarts the configured runtime", async (t) => {
  const fixture = compactFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(await fixture.host.setUseNewCompactMode(true), true);
  assert.equal(JSON.parse(fs.readFileSync(fixture.configPath, "utf8")).useNewCompactMode, true);
  assert.deepEqual(fixture.calls, ["stop", "start"]);

  assert.equal(await fixture.host.setUseNewCompactMode(true), true);
  assert.deepEqual(fixture.calls, ["stop", "start"]);
});

test("launcher restores the prior compact mode when runtime restart fails", async (t) => {
  const fixture = compactFixture({
    startResults: [{ status: "error", detail: "synthetic startup failure" }, { status: "ready" }],
  });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  await assert.rejects(
    fixture.host.setUseNewCompactMode(true),
    /synthetic startup failure/,
  );
  assert.equal(JSON.parse(fs.readFileSync(fixture.configPath, "utf8")).useNewCompactMode, undefined);
  assert.deepEqual(fixture.calls, ["stop", "start", "start"]);
});

test("launcher exposes the Beta compact toggle through UI and IPC", () => {
  const root = path.join(__dirname, "..");
  const app = fs.readFileSync(path.join(root, "src", "App.tsx"), "utf8");
  const types = fs.readFileSync(path.join(root, "src", "types.ts"), "utf8");
  const i18n = fs.readFileSync(path.join(root, "src", "i18n.ts"), "utf8");
  const main = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(root, "electron", "preload.cjs"), "utf8");

  assert.match(types, /useNewCompactMode: boolean/);
  assert.match(types, /setUseNewCompactMode\(enabled: boolean\)/);
  assert.match(i18n, /Use new compact mode \(Beta\)/);
  assert.match(i18n, /使用新版 compact 壓縮方式（Beta）/);
  assert.match(app, /checked=\{snapshot\.state\.useNewCompactMode\}/);
  assert.match(app, /api!\.setUseNewCompactMode\(enabled\)/);
  assert.match(main, /launcher:new-compact-mode/);
  assert.match(main, /runtimeHost\.setUseNewCompactMode\(enabled === true\)/);
  assert.match(preload, /setUseNewCompactMode: \(enabled\).*launcher:new-compact-mode/);
});
