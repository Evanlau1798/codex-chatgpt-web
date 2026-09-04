const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { validateConfig } = require("../electron/runtime-supervisor.cjs");

const root = path.resolve(__dirname, "..");
const descriptor = path.join(root, "test-descriptor.json");
const tunnel = name => ({
  binaryPath: process.execPath, tunnelId: `tunnel_${(name === "manual" ? "a" : "b").repeat(32)}`,
  runtimeKeyFile: path.join(root, `${name}.key`), profileDir: root, profileName: name, alias: name,
});
function config(mode = "manual") {
  const automaticTunnel = tunnel("automatic");
  const manualTunnel = tunnel("manual");
  return {
    version: 3, releaseVersion: "5.0.0-Enhanced.1", mode: "full", browserInteractionMode: mode,
    browserHost: "launcher", browserHostDescriptorPath: descriptor,
    host: "127.0.0.1", port: 17841, controlToken: "x".repeat(40), contextWindow: 100_000,
    appName: "Codex Zero Risk", chromeExecutablePath: process.execPath, storageStatePath: root,
    brokerSocketPath: process.platform === "win32" ? "\\\\.\\pipe\\zero-risk-config-test" : path.join(root, "test.sock"),
    headed: true, solAvailable: true, proAvailable: true, autoApproveToolCalls: false,
    useEnhancedWebSessionMode: true, runtimeCommand: [process.execPath],
    automaticTunnel, manualTunnel, tunnel: mode === "manual" ? manualTunnel : automaticTunnel,
  };
}

for (const mode of ["manual", "automatic"]) {
  test(`accepts isolated ${mode} tunnel identity`, () => {
    assert.equal(validateConfig(config(mode), descriptor).browserInteractionMode, mode);
  });
}
test("legacy configuration defaults to Automatic without creating a manual identity", () => {
  const value = config("automatic");
  delete value.browserInteractionMode;
  delete value.automaticTunnel;
  delete value.manualTunnel;
  assert.equal(validateConfig(value, descriptor).browserInteractionMode, "automatic");
});
for (const [name, mutate, expected] of [
  ["invalid interaction mode", value => { value.browserInteractionMode = "invalid"; }, /invalid browser interaction mode/],
  ["shared tunnel ID", value => { value.manualTunnel.tunnelId = value.automaticTunnel.tunnelId; }, /tunnel IDs must differ/],
  ["missing active identity", value => { delete value.manualTunnel; }, /has no tunnel configuration/],
  ["wrong active identity", value => { value.tunnel = value.automaticTunnel; }, /does not match the active tunnel/],
  ["invalid inactive profile", value => { value.automaticTunnel.runtimeKeyFile = "relative.key"; }, /absolute automaticTunnel.runtimeKeyFile/],
]) {
  test(`rejects ${name} before starting services`, () => {
    const value = config();
    mutate(value);
    assert.throws(() => validateConfig(value, descriptor), expected);
  });
}
