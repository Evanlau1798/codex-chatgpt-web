const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

test("boot ownership uses the pinned five-second tolerance and retains future markers", () => {
  const loaded = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve("../electron/process-tree.cjs"), "utf8"), {
    module: loaded, process,
    require: name => name === "node:os" ? { uptime: () => 10 } : require(name),
    Date: { now: () => 20_000, parse: Date.parse },
  });
  const predates = loaded.exports.runtimeOwnershipPredatesCurrentBoot;
  for (const [time, expected] of [[4_999, true], [5_000, false], [5_001, false], [30_000, false]]) {
    assert.equal(predates({ updatedAt: new Date(time).toISOString() }), expected);
  }
  assert.equal(predates({ updatedAt: "invalid" }), false);
  assert.equal(predates(null), false);
});

function fixture(t, priorBoot = true, launcherProfile = "production") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-boot-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "5.0.0-Enhanced.1" },
    logger: { info() {}, warn() {}, error() {} },
    coreHome: root,
    browserDescriptorPath: path.join(root, "browser.json"),
    launcherProfile,
  });
  fs.mkdirSync(path.dirname(supervisor.statePath), { recursive: true });
  fs.writeFileSync(supervisor.statePath, JSON.stringify({
    version: 1, status: "ready", ownerPid: process.pid,
    daemonPid: process.pid, tunnelPid: process.pid,
    updatedAt: new Date(priorBoot ? Date.now() - (os.uptime() + 60) * 1_000 : Date.now()).toISOString(),
  }));
  supervisor.proxyHealth = async () => false;
  supervisor.proxyHealthPayload = async () => null;
  supervisor.control = async () => { throw new Error("must not control a reused PID"); };
  supervisor.runTunnelStopCommand = async () => { throw new Error("must not stop an unowned tunnel"); };
  return supervisor;
}

test("external migration discards prior-boot PIDs but protects current-boot owners", t => {
  const stale = fixture(t);
  assert.doesNotThrow(() => stale.prepareExternalMigration());
  assert.equal(stale.readState(), null);
  const current = fixture(t, false);
  assert.throws(() => current.prepareExternalMigration(), /still alive/);
  assert.equal(current.readState().status, "ready");
});

test("external-state publication does not preserve prior-boot ownership", t => {
  const stale = fixture(t);
  stale.writeExternalState("external installation");
  assert.equal(stale.readState().status, "external");
  const current = fixture(t, false);
  current.writeExternalState("external installation");
  assert.equal(current.readState().status, "ready");
});

test("startup without config ignores prior-boot markers and preserves live markers", async t => {
  const stale = fixture(t);
  assert.deepEqual(await stale.startIfConfigured(), { status: "not-configured" });
  assert.equal(stale.readState(), null);
  const current = fixture(t, false);
  assert.equal((await current.startIfConfigured()).status, "external");
  assert.equal(current.readState().status, "ready");
});

test("stop without config ignores prior-boot PIDs without sending control requests", async t => {
  const stale = fixture(t);
  assert.deepEqual(await stale.stopForSetup(), { status: "stopped" });
  assert.equal(stale.readState(), null);
  const current = fixture(t, false);
  await assert.rejects(current.stopForSetup(), /configuration is missing/);
});

test("stale cleanup checks boot identity before health, DEV daemon checks or process control", async t => {
  for (const profile of ["production", "development"]) {
    const stale = fixture(t, true, profile);
    stale.proxyHealthPayload = async () => { throw new Error("must not inspect a prior-boot process"); };
    assert.equal(await stale.stopStaleOwnedRuntime({ mode: "full" }), false);
    assert.equal(stale.readState(), null);
  }
  const current = fixture(t, false);
  await assert.rejects(current.stopStaleOwnedRuntime({ mode: "browser-only" }), /did not provide matching health/);
});

test("configured startup does not treat prior-boot ownership as a live runtime", async t => {
  const production = fixture(t);
  production.readConfig = () => ({ mode: "browser-only", releaseVersion: "5.0.0-Enhanced.1" });
  const starts = [];
  production.startTunnel = async () => { starts.push("tunnel"); };
  production.startDaemon = async () => { starts.push("daemon"); };
  assert.equal((await production.startIfConfigured()).status, "ready");
  assert.deepEqual(starts, ["tunnel", "daemon"]);

  const development = fixture(t, true, "development");
  development.readConfig = () => ({ mode: "browser-only", releaseVersion: "5.0.0-Enhanced.1" });
  assert.equal((await development.startIfConfigured()).status, "ready");
  assert.equal(development.readState(), null);
});

test("Full setup stop does not adopt a tunnel solely from a prior-boot marker", async t => {
  const stale = fixture(t);
  stale.readConfig = () => ({ mode: "full", releaseVersion: "5.0.0-Enhanced.1" });
  stale.adoptConfiguredTunnelForStop = async () => { throw new Error("must not adopt a prior-boot tunnel"); };
  assert.deepEqual(await stale.stopForSetup(), { status: "stopped" });
  assert.equal(stale.readState(), null);
});

test("a healthy runtime remains external even when its ownership marker predates boot", async t => {
  const stale = fixture(t);
  stale.readConfig = () => ({ mode: "browser-only", releaseVersion: "5.0.0-Enhanced.1" });
  stale.proxyHealth = async () => true;
  stale.startDaemon = async () => { throw new Error("must not replace a healthy unowned runtime"); };
  assert.equal((await stale.startIfConfigured()).status, "external");
});
