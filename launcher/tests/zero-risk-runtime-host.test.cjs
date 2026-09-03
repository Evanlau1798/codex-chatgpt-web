const assert = require("node:assert/strict");
const test = require("node:test");
const { RuntimeHost } = require("../electron/runtime.cjs");

function fixture(config, mode = "automatic") {
  const host = new RuntimeHost({
    app: { getPath: () => process.cwd(), getVersion: () => "5.0.0" },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: process.cwd(),
    browserDescriptorPath: "C:\\runtime\\browser.json",
    getBrowserInteractionMode: () => mode,
    supervisor: { readConfig: () => config, readSetupConfig: () => config },
  });
  let invocation;
  host.runSetup = async (name, args) => {
    invocation = { name, args };
    return { stdout: "" };
  };
  return { host, invocation: () => invocation };
}

test("Zero Risk requires a Full installation and explicit credentials", async () => {
  await assert.rejects(fixture(null, "manual").host.setupCore(), /must be installed through MCP setup/);
  await assert.rejects(
    fixture({ mode: "browser-only", browserHost: "launcher" }).host.setBrowserInteractionMode("manual"),
    /Full MCP harness/,
  );
  assert.equal(fixture({ mode: "full", tunnel: { tunnelId: "tunnel_legacy" } }).host.mcpCredentialsConfigured("manual"), false);
});

test("interaction mode setup preserves the Automatic connector and refreshes only Automatic", async () => {
  const config = {
    mode: "full", browserHost: "launcher", appName: "Codex Zero Risk",
    automaticAppName: "Codex Native2", manualAppName: "Codex Zero Risk", browserInteractionMode: "manual",
  };
  const automatic = fixture(config, "manual");
  await automatic.host.setBrowserInteractionMode("automatic");
  assert.equal(automatic.invocation().args.includes("--refresh-account-capabilities"), true);
  assert.deepEqual(automatic.invocation().args.slice(-2), ["--app-name", "Codex Native2"]);

  const manual = fixture({ ...config, browserInteractionMode: "automatic" });
  await manual.host.setBrowserInteractionMode("manual");
  assert.equal(manual.invocation().args.includes("--refresh-account-capabilities"), false);
  assert.equal(manual.invocation().args.includes("--standard-context"), true);
  assert.deepEqual(manual.invocation().args.slice(-2), ["--app-name", "Codex Zero Risk"]);
});

test("MCP setup provisions credentials for the requested inactive interaction mode", async () => {
  const value = fixture({
    mode: "full", browserHost: "launcher", browserInteractionMode: "automatic",
    automaticAppName: "Codex Native2", manualAppName: "Codex Zero Risk",
  });
  await value.host.setupMcp({
    interactionMode: "manual",
    replace: true,
    tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    runtimeKey: "new-private-runtime-key",
  });
  assert.deepEqual(value.invocation().args.slice(4, 8), [
    "--zero-risk-browser-interaction", "--app-name", "Codex Zero Risk", "--replace-codex-route",
  ]);
});

test("Zero Risk Pro is an explicit transactional profile", async () => {
  const value = fixture({
    mode: "full", browserHost: "launcher", browserInteractionMode: "manual",
    appName: "Codex Zero Risk", automaticAppName: "Codex Native2", manualAppName: "Codex Zero Risk",
  }, "manual");
  const result = await value.host.setZeroRiskPro(true);
  assert.equal(result.enabled, true);
  assert.equal(value.invocation().args.includes("--zero-risk-pro"), true);
  assert.deepEqual(value.invocation().args.slice(4, 8), ["--zero-risk-browser-interaction", "--app-name", "Codex Zero Risk", "--acknowledge-unofficial"]);
});
