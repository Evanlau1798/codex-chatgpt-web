const test = require("node:test");
const assert = require("node:assert/strict");
const { RuntimeHost } = require("../electron/runtime.cjs");

function fixture(owner = "launcher", profile = "production") {
  const events = [];
  const config = owner === "none" ? null : { mode: "browser-only", browserHost: owner === "launcher" ? "launcher" : "managed-chrome" };
  const host = new RuntimeHost({
    app: { getPath: () => process.cwd() }, sourceRoot: process.cwd(), coreHome: process.cwd(), launcherProfile: profile,
    logger: { info() {}, warn() {}, error() {} },
    supervisor: {
      readConfig: () => config, readSetupConfig: () => config,
      stopForSetup: async () => { events.push("stop"); },
      prepareExternalMigration: () => { events.push("migrate"); },
      startIfConfigured: async () => { events.push("start"); return { status: "ready" }; },
    },
  });
  host.captureSetupCheckpoint = () => ({});
  host.restoreSetupCheckpoint = () => { events.push("restore"); };
  host.setupCheckpointChanged = () => false;
  host.restorePreviousRuntime = async () => { events.push("recover"); };
  host.rollbackFirstSetup = async () => { events.push("rollback"); };
  return { host, events };
}

for (const owner of ["launcher", "external", "none"]) {
  test(`failed setup preflight leaves ${owner} runtime untouched`, async () => {
    const { host, events } = fixture(owner);
    host.run = async (_name, args) => {
      events.push(args.includes("--preflight-only") ? "preflight" : "setup");
      throw new Error("invalid integration configuration");
    };
    await assert.rejects(host.runSetup("setup", ["setup", "--browser-only"], {}), /invalid integration configuration/);
    assert.deepEqual(events, ["preflight"]);
    assert.equal(host.currentOperation(), null);
  });
}

for (const profile of ["production", "development"]) {
  test(`${profile} setup preserves validation and transition ordering`, async () => {
    const { host, events } = fixture("launcher", profile);
    host.run = async (_name, args, options) => {
      const preflight = args.includes("--preflight-only");
      events.push(preflight ? "preflight" : "setup");
      if (preflight) assert.equal(options.timeoutMs, 15_000);
      return { stdout: "done" };
    };
    assert.deepEqual(await host.runSetup("setup", ["setup", "--browser-only"], { timeoutMs: 120_000 }), { stdout: "done" });
    assert.deepEqual(events, profile === "production" ? ["preflight", "stop", "setup", "start"] : ["stop", "setup", "start"]);
  });
}
