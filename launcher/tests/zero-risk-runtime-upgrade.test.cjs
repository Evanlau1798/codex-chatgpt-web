const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { RuntimeHost } = require("../electron/runtime.cjs");
const { validateConfig } = require("../electron/runtime-supervisor.cjs");

function fixture(mode, mutation) {
  const profileName = mode === "manual" ? "codex-chatgpt-web-zero-risk" : "codex-chatgpt-web";
  const tunnel = {
    tunnelId: "tunnel_0123456789abcdef0123456789abcdef", alias: profileName, profileName,
    runtimeKeyFile: path.join(process.cwd(), mode === "manual" ? "tunnel-runtime-zero-risk.key" : "tunnel-runtime-automatic.key"),
  };
  const slot = mode === "manual" ? "manualTunnel" : "automaticTunnel";
  const config = {
    mode: "full", browserHost: "launcher", browserInteractionMode: mode,
    releaseVersion: "5.0.0-Enhanced.1", appName: mode === "manual" ? "Codex Zero Risk" : "Codex Native2",
    automaticAppName: "Codex Native2", manualAppName: "Codex Zero Risk",
    tunnel, [slot]: structuredClone(tunnel),
  };
  mutation?.(config, slot);
  const host = new RuntimeHost({
    app: { getPath: () => process.cwd(), getVersion: () => config.releaseVersion },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: process.cwd(), browserDescriptorPath: path.join(process.cwd(), "browser.json"),
    getBrowserInteractionMode: () => mode,
    supervisor: { readSetupConfig: () => config, readConfig: () => config },
  });
  const calls = [];
  host.bridgeStatus = async () => ({ active: false });
  host.setBridgeEnabled = async value => { calls.push({ disabled: !value }); };
  host.runSetup = async (name, args, options) => { calls.push({ name, args, options }); return { stdout: "" }; };
  return { host, calls, config };
}

for (const mode of ["automatic", "manual"]) {
  const mutations = {
    "missing explicit profile": (config, slot) => { delete config[slot]; },
    "different tunnel identity": (config, slot) => { config[slot].tunnelId = "tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; },
    "legacy profile name": config => { config.tunnel.profileName = "legacy"; },
    "legacy alias": config => { config.tunnel.alias = "legacy"; },
    "shared key file": config => { config.tunnel.runtimeKeyFile = path.join(process.cwd(), "tunnel-runtime.key"); },
  };
  for (const [label, mutation] of Object.entries(mutations)) {
    test(`same-version ${mode} upgrade migrates ${label} and preserves disconnected route`, async () => {
      const { host, calls } = fixture(mode, mutation);
      const result = await host.upgradeManagedRuntime();
      assert.equal(result.updated, true);
      assert.equal(result.bridgeEnabled, false);
      assert.equal(calls[0].args.includes(mode === "manual" ? "--zero-risk-browser-interaction" : "--automatic-browser-interaction"), true);
      assert.deepEqual(calls[0].args.slice(-2), ["--app-name", "Codex Native2"]);
      assert.deepEqual(calls[1], { disabled: true });
    });
  }
  test(`same-version ${mode} aligned profile needs no runtime upgrade`, async () => {
    const { host, calls } = fixture(mode);
    assert.deepEqual(await host.upgradeManagedRuntime(), { updated: false });
    assert.deepEqual(calls, []);
  });
  test(`validated ${mode} legacy profile reaches the same-version migration`, async () => {
    const { host, calls, config } = fixture(mode);
    Object.assign(config, {
      version: 3, host: "127.0.0.1", port: 17841, contextWindow: 123_000,
      browserHostDescriptorPath: host.browserDescriptorPath,
      controlToken: "fixture-control-token-not-a-real-secret-1234567890",
      chromeExecutablePath: process.execPath, storageStatePath: path.join(process.cwd(), "state.json"),
      brokerSocketPath: process.platform === "win32" ? "\\\\.\\pipe\\cgw-upgrade-test" : path.join(process.cwd(), "broker.sock"),
      headed: true, solAvailable: true, proAvailable: true, autoApproveToolCalls: false,
      useEnhancedWebSessionMode: false, runtimeCommand: [process.execPath],
    });
    Object.assign(config.tunnel, {
      binaryPath: process.execPath, profileDir: process.cwd(), alias: "legacy", profileName: "legacy",
      runtimeKeyFile: path.join(process.cwd(), "tunnel-runtime.key"),
    });
    if (mode === "automatic") delete config.automaticTunnel;
    else config.manualTunnel = structuredClone(config.tunnel);
    host.supervisor.readConfig = () => validateConfig(config, host.browserDescriptorPath);
    assert.equal((await host.upgradeManagedRuntime()).updated, true);
    assert.equal(calls[0].name, "runtime-upgrade");
  });
}
