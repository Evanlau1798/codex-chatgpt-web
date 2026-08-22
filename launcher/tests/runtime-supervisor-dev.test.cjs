const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RuntimeSupervisor, validateConfig } = require("../electron/runtime-supervisor.cjs");

function launcherConfig(descriptorPath, overrides = {}) {
  const root = path.dirname(descriptorPath);
  return {
    version: 3,
    releaseVersion: "3.0.0",
    mode: "browser-only",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    chromeExecutablePath: process.execPath,
    storageStatePath: path.join(root, "storage-state.json"),
    brokerSocketPath: process.platform === "win32"
      ? "\\\\.\\pipe\\codex-chatgpt-web-runtime-supervisor-dev-test"
      : path.join(root, "turn-broker.sock"),
    headed: true,
    solAvailable: true,
    proAvailable: true,
    autoApproveToolCalls: false,
    controlToken: "runtime-supervisor-control-token-0123456789abcdef",
    runtimeCommand: [process.execPath],
    ...overrides,
  };
}

test("launcher runtime ownership cannot cross production and DEV profiles", () => {
  const descriptorPath = path.join(os.tmpdir(), "launcher.json");
  const production = launcherConfig(descriptorPath);
  const development = { ...production, purpose: "dev-harness" };
  assert.equal(validateConfig(production, descriptorPath, process.platform, "production"), production);
  assert.equal(validateConfig(development, descriptorPath, process.platform, "development"), development);
  assert.throws(
    () => validateConfig(development, descriptorPath, process.platform, "production"),
    /Production launcher refuses a DEV harness/,
  );
  assert.throws(
    () => validateConfig(production, descriptorPath, process.platform, "development"),
    /DEV launcher refuses a configuration/,
  );
});

test("DEV runtime supervision starts only the isolated MCP tunnel", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-dev-tunnel-supervisor-"));
  const descriptorPath = path.join(root, "runtime", "launcher-browser.json");
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  const config = launcherConfig(descriptorPath, {
    purpose: "dev-harness",
    mode: "full",
    appName: "Codex Native2 DEV",
    tunnel: {
      binaryPath: path.join(root, "bin", "tunnel-client"),
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: path.join(root, "secrets", "runtime.key"),
      profileDir: path.join(root, "tunnel", "profiles"),
      profileName: "codex-chatgpt-web-dev",
      alias: "codex-chatgpt-web-dev",
    },
  });
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify(config)}\n`);
  let daemonStarts = 0;
  let proxyProbes = 0;
  let tunnelStarts = 0;
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "3.0.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: descriptorPath,
    launcherProfile: "development",
  });
  supervisor.proxyHealth = async () => { proxyProbes += 1; return false; };
  supervisor.startTunnel = async () => {
    tunnelStarts += 1;
    supervisor.tunnel = { pid: 123_456_789, exitCode: null, signalCode: null, managed: true };
  };
  supervisor.startDaemon = async () => { daemonStarts += 1; };
  supervisor.tunnelHealth = async () => true;
  try {
    const runtime = await supervisor.startConfigured();
    assert.equal(runtime.status, "ready");
    assert.equal(runtime.daemonPid, undefined);
    assert.equal(runtime.tunnelPid, 123_456_789);
    assert.equal(tunnelStarts, 1);
    assert.equal(daemonStarts, 0);
    assert.equal(proxyProbes, 0);
    assert.equal(await supervisor.ownedRuntimeReady(config), true);
    const state = JSON.parse(fs.readFileSync(supervisor.statePath, "utf8"));
    assert.equal(state.daemonPid, null);
    assert.equal(state.tunnelPid, 123_456_789);
  } finally {
    supervisor.tunnel = null;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
