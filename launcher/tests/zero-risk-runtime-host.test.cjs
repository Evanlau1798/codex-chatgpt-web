const assert = require("node:assert/strict");
const test = require("node:test");
const { RuntimeHost } = require("../electron/runtime.cjs");

function fixture(config, mode = "automatic", profile = "production") {
  const host = new RuntimeHost({
    app: { getPath: () => process.cwd(), getVersion: () => "5.0.0" },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: process.cwd(),
    coreHome: process.cwd(),
    launcherProfile: profile,
    browserDescriptorPath: "C:\\runtime\\browser.json",
    getBrowserInteractionMode: () => mode,
    supervisor: { readConfig: () => config, readSetupConfig: () => config },
  });
  let invocation;
  host.runSetup = async (name, args) => {
    invocation = { name, args, profile: "production" };
    return { stdout: "" };
  };
  host.runDevSetup = async (name, args) => {
    invocation = { name, args, profile: "development" };
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

for (const profile of ["production", "development"]) {
  for (const enabled of [true, false]) {
    test(`${profile} Zero Risk Pro ${enabled ? "enable" : "disable"} preserves manual transaction boundaries`, async () => {
      const value = fixture({
        mode: "full", browserHost: "launcher", browserInteractionMode: "manual",
        autoApproveToolCalls: true,
        appName: "Codex Zero Risk", automaticAppName: "Codex Native2", manualAppName: "Codex Zero Risk",
      }, "manual", profile);
      assert.equal((await value.host.setZeroRiskPro(enabled)).enabled, enabled);
      const call = value.invocation();
      assert.equal(call.profile, profile);
      assert.equal(call.args.includes(enabled ? "--zero-risk-pro" : "--zero-risk-default"), true);
      assert.equal(call.args.includes(enabled ? "--zero-risk-default" : "--zero-risk-pro"), false);
      assert.equal(call.args.includes("--zero-risk-browser-interaction"), true);
      assert.equal(call.args.includes("--standard-context"), true);
      assert.equal(call.args.includes("--auto-approve-tool-calls"), true);
      assert.equal(call.args.includes("--refresh-account-capabilities"), false);
      assert.equal(call.args.includes("--restart-service"), profile === "production");
      assert.deepEqual(call.args.slice(0, profile === "production" ? 1 : 2), profile === "production" ? ["setup"] : ["dev", "setup"]);
    });
  }
  test(`${profile} mode changes preserve the saved tool approval preference`, async () => {
    for (const mode of ["automatic", "manual"]) {
      const value = fixture({
        mode: "full", browserHost: "launcher", browserInteractionMode: "manual", autoApproveToolCalls: true,
        appName: "Codex Zero Risk", automaticAppName: "Codex Native2", manualAppName: "Codex Zero Risk",
      }, "manual", profile);
      await value.host.setBrowserInteractionMode(mode);
      assert.equal(value.invocation().args.includes("--auto-approve-tool-calls"), true);
    }
  });
  test(`${profile} invalid Zero Risk Pro settings never dispatch setup`, async () => {
    for (const config of [null, { mode: "browser-only", browserHost: "launcher" },
      { mode: "full", browserHost: "launcher", browserInteractionMode: "automatic" }]) {
      const value = fixture(config, "automatic", profile);
      await assert.rejects(value.host.setZeroRiskPro(true), /Install the Codex integration|Full Zero Risk harness/);
      assert.equal(value.invocation(), undefined);
    }
  });
}

test("manual core repair preserves selected Codex or Claude integration without refreshing account capabilities", async () => {
  for (const integration of ["codex", "claude"]) {
    const value = fixture({
      mode: "full", browserHost: "launcher", browserInteractionMode: "manual",
      appName: "Codex Zero Risk", automaticAppName: "Codex Native2", manualAppName: "Codex Zero Risk",
    }, "manual");
    await value.host.setupCore(integration);
    assert.equal(value.invocation().args.includes(`--${integration}-only`), true);
    assert.equal(value.invocation().args.includes("--zero-risk-browser-interaction"), true);
    assert.equal(value.invocation().args.includes("--refresh-account-capabilities"), false);
    assert.deepEqual(value.invocation().args.slice(-2), ["--app-name", "Codex Native2"]);
  }
  const unconfigured = fixture(null, "manual");
  await assert.rejects(unconfigured.host.setupCore(), /must be installed through MCP setup/);
  assert.equal(unconfigured.invocation(), undefined);
});
