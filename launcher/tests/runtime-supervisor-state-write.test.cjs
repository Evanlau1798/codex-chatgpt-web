const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");
const { DETACH_OWNED_CHILD, processRunning, terminateOwnedProcessTree } = require("../electron/process-tree.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-state-write-"));
  const errors = [];
  const operations = [];
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error(event, detail) { errors.push({ event, ...detail }); } },
    sourceRoot: root, coreHome: root, browserDescriptorPath: path.join(root, "launcher.json"),
    publishOperation: operation => operations.push(operation),
  });
  return { root, supervisor, errors, operations };
}

async function until(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(predicate(), message);
}

function failWrites(supervisor) {
  supervisor.writeState = () => { throw new Error("synthetic ownership ENOSPC"); };
}

test("ownership write failure stops each owned daemon generation without touching another process", async () => {
  const { root, supervisor, operations } = fixture();
  const foreign = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: root, detached: DETACH_OWNED_CHILD, stdio: "ignore", windowsHide: true,
  });
  await once(foreign, "spawn");
  const writeState = supervisor.writeState.bind(supervisor);
  try {
    for (let generation = 0; generation < 2; generation += 1) {
      // A later explicit start must not be exempted by a lifetime cleanup latch.
      supervisor.stopping = false;
      supervisor.writeState = writeState;
      const child = supervisor.spawnChild("daemon", {
        executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: root,
      });
      await once(child, "spawn");
      failWrites(supervisor);
      supervisor.restartTimers.daemon = setTimeout(() => assert.fail("recovery must stay stopped"), 30_000);
      assert.equal(supervisor.tryWriteState("ready"), false);
      assert.equal(supervisor.stopping, true);
      assert.equal(supervisor.restartTimers.daemon, null);
      await until(() => child.exitCode !== null || child.signalCode !== null, "owned daemon must exit after persistence fails");
      assert.equal(processRunning(child.pid), false);
      assert.equal(processRunning(foreign.pid), true, "unowned process must remain alive");
    }
    assert.ok(operations.some(operation => operation.status === "failed" && /ENOSPC/.test(operation.message)));
  } finally {
    await supervisor.stopChild("daemon").catch(() => {});
    if (foreign.exitCode === null && foreign.signalCode === null) {
      const exited = once(foreign, "exit");
      terminateOwnedProcessTree(foreign);
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed tunnel cleanup uses its native stop contract and coalesces repeated failed writes", async () => {
  const { root, supervisor } = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const commands = [];
  let terminalChecks = 0;
  const managed = { pid: null, exitCode: null, signalCode: null, managed: true };
  supervisor.tunnel = managed;
  supervisor.readConfig = () => ({ tunnel: { alias: "owned-fixture" } });
  supervisor.runTunnelStopCommand = async config => { commands.push(config.tunnel.alias); await gate; return { code: 0 }; };
  supervisor.waitForTunnelStopped = async () => { terminalChecks += 1; return { state: "stopped", processRunning: false }; };
  failWrites(supervisor);
  try {
    assert.equal(supervisor.tryWriteState("ready"), false);
    assert.equal(supervisor.tryWriteState("degraded"), false);
    await until(() => commands.length > 0, "native managed tunnel stop must be requested");
    assert.deepEqual(commands, ["owned-fixture"]);
    assert.equal(supervisor.tunnel, managed, "retain ownership until terminal evidence");
    release();
    await until(() => supervisor.tunnel === null, "managed tunnel must have terminal proof before release");
    assert.equal(terminalChecks, 1);
    assert.equal(supervisor.stopping, true);
    assert.equal(supervisor.tunnelMonitorTimer, null);
  } finally {
    release();
    supervisor.stopTunnelMonitor();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed managed cleanup preserves ownership and reports the failure without PID termination", async () => {
  const { root, supervisor, errors } = fixture();
  const managed = {
    pid: null, exitCode: null, signalCode: null, managed: true,
    kill() { assert.fail("manager-owned metadata must not use child-process termination"); },
  };
  supervisor.tunnel = managed;
  supervisor.readConfig = () => ({ tunnel: { alias: "owned-fixture" } });
  supervisor.runTunnelStopCommand = async () => { throw new Error("synthetic manager unavailable"); };
  supervisor.startTunnelMonitor = () => { supervisor.tunnelMonitorTimer = setInterval(() => {}, 30_000); };
  failWrites(supervisor);
  try {
    assert.equal(supervisor.tryWriteState("ready"), false);
    await until(() => errors.some(error => error.event === "runtime.state_write_cleanup_failed"), "cleanup failure must remain observable");
    assert.equal(supervisor.tunnel, managed);
    assert.equal(supervisor.stopping, true);
    assert.equal(supervisor.tunnelMonitorTimer, null);
    assert.ok(errors.some(error => /synthetic manager unavailable/.test(error.message)));
  } finally {
    supervisor.stopTunnelMonitor();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explicit startup waits for an outstanding ownership-failure cleanup", async () => {
  const { root, supervisor } = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let starts = 0;
  supervisor.tunnel = { pid: null, exitCode: null, signalCode: null, managed: true };
  supervisor.readConfig = () => ({ tunnel: { alias: "owned-fixture" } });
  supervisor.runTunnelStopCommand = async () => { await gate; return { code: 0 }; };
  supervisor.waitForTunnelStopped = async () => ({ state: "stopped", processRunning: false });
  supervisor.startConfigured = async () => { starts += 1; return { status: "not-configured" }; };
  failWrites(supervisor);
  let starting;
  try {
    supervisor.tryWriteState("ready");
    starting = supervisor.startIfConfigured();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts, 0, "do not replace a child whose cleanup is still pending");
    release();
    assert.deepEqual(await starting, { status: "not-configured" });
    assert.equal(starts, 1);
  } finally {
    release();
    await starting;
    await Promise.allSettled([...supervisor.recoveryTasks]);
    supervisor.stopTunnelMonitor();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recovery failure joins the existing managed cleanup instead of issuing a second stop", async () => {
  const { root, supervisor } = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let stops = 0;
  const config = { tunnel: { alias: "owned-fixture" } };
  supervisor.tunnel = { pid: null, exitCode: null, signalCode: null, managed: true };
  supervisor.readConfig = () => config;
  supervisor.runTunnelStopCommand = async () => { stops += 1; await gate; return { code: 0 }; };
  supervisor.waitForTunnelStopped = async () => ({ state: "stopped", processRunning: false });
  failWrites(supervisor);
  let cleanup;
  try {
    supervisor.tryWriteState("ready");
    cleanup = supervisor.cleanupFailedStart(config);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stops, 1);
    release();
    await cleanup;
    assert.equal(supervisor.tunnel, null);
  } finally {
    release();
    await cleanup;
    await Promise.allSettled([...supervisor.recoveryTasks]);
    supervisor.stopTunnelMonitor();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed degraded-state write retains the monitored tunnel for native cleanup", async t => {
  const { root, supervisor } = fixture();
  t.mock.timers.enable({ apis: ["setInterval"] });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let stops = 0;
  const managed = { pid: null, exitCode: null, signalCode: null, managed: true };
  const config = { tunnel: { alias: "owned-fixture" } };
  supervisor.tunnel = managed;
  supervisor.readConfig = () => config;
  supervisor.observeTunnelForMonitor = async () => ({ statusKnown: true, ready: false, fatal: true, detail: "synthetic unhealthy tunnel" });
  supervisor.runTunnelStopCommand = async () => { stops += 1; await gate; return { code: 0 }; };
  supervisor.waitForTunnelStopped = async () => ({ state: "stopped", processRunning: false });
  failWrites(supervisor);
  try {
    supervisor.startTunnelMonitor(config);
    t.mock.timers.tick(10_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stops, 1, "failed persistence must not discard the owned tunnel reference");
    assert.equal(supervisor.tunnel, managed);
    release();
    await until(() => supervisor.tunnel === null, "native stop must settle");
    assert.equal(supervisor.restartTimers.tunnel, null);
  } finally {
    release();
    await Promise.allSettled([...supervisor.recoveryTasks]);
    supervisor.stopTunnelMonitor();
    t.mock.timers.reset();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("settled cleanup does not erase a newer managed tunnel reference", async () => {
  const { root, supervisor } = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  supervisor.tunnel = { pid: null, exitCode: null, signalCode: null, managed: true };
  supervisor.readConfig = () => ({ tunnel: { alias: "owned-fixture" } });
  supervisor.runTunnelStopCommand = async () => { await gate; return { code: 0 }; };
  supervisor.waitForTunnelStopped = async () => ({ state: "stopped", processRunning: false });
  failWrites(supervisor);
  try {
    supervisor.tryWriteState("ready");
    // A recovery already in flight can publish a newer identity while stop is awaiting proof.
    const replacement = { pid: null, exitCode: null, signalCode: null, managed: true };
    supervisor.tunnel = replacement;
    release();
    await Promise.allSettled([...supervisor.recoveryTasks]);
    assert.equal(supervisor.tunnel, replacement);
  } finally {
    release();
    await Promise.allSettled([...supervisor.recoveryTasks]);
    supervisor.stopTunnelMonitor();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("successful persistence and foreign marker evidence do not authorize child cleanup", () => {
  const { root, supervisor } = fixture();
  let cleanup = 0;
  supervisor.stopChild = async () => { cleanup += 1; };
  supervisor.stopTunnelGracefully = async () => { cleanup += 1; };
  try {
    assert.equal(supervisor.tryWriteState("ready"), true);
    assert.equal(supervisor.stopping, false);
    supervisor.readState = () => ({ ownerPid: process.pid + 1, daemonPid: process.pid, tunnelPid: process.pid });
    failWrites(supervisor);
    assert.equal(supervisor.tryWriteState("degraded"), false);
    assert.equal(cleanup, 0, "disk marker PIDs alone cannot grant process ownership");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
