const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

function exited(child, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    child.once("exit", () => resolve(true));
    setTimeout(() => resolve(false), timeoutMs).unref?.();
  });
}

test("setup stop preserves ownership held by another live launcher when config is missing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-stop-live-owner-"));
  const liveOwner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "3.0.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const state = {
    version: 1,
    ownerPid: liveOwner.pid,
    daemonPid: null,
    tunnelPid: null,
    status: "ready",
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(supervisor.statePath), { recursive: true });
  fs.writeFileSync(supervisor.statePath, `${JSON.stringify(state)}\n`);
  try {
    await assert.rejects(
      supervisor.stopForSetup(),
      /Another launcher process still owns the runtime/,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(supervisor.statePath, "utf8")), state);
  } finally {
    const ownerExited = exited(liveOwner);
    liveOwner.kill("SIGKILL");
    await ownerExited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("setup stop never adopts a tunnel owned by another live launcher", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-stop-foreign-tunnel-"));
  const liveOwner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const descriptorPath = path.join(root, "launcher.json");
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "3.0.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: descriptorPath,
  });
  fs.writeFileSync(descriptorPath, "{}\n");
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 3,
    releaseVersion: "3.0.0",
    mode: "full",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    chromeExecutablePath: process.execPath,
    storageStatePath: path.join(root, "storage-state.json"),
    brokerSocketPath: process.platform === "win32"
      ? "\\\\.\\pipe\\codex-chatgpt-web-foreign-owner-test"
      : path.join(root, "turn-broker.sock"),
    headed: true,
    proAvailable: true,
    autoApproveToolCalls: false,
    controlToken: "foreign-owner-control-token-0123456789abcdef",
    runtimeCommand: [process.execPath],
    tunnel: {
      binaryPath: path.join(root, "tunnel-client"),
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: path.join(root, "runtime.key"),
      profileDir: path.join(root, "profiles"),
      profileName: "codex-chatgpt-web",
      alias: "codex-chatgpt-web",
    },
  })}\n`);
  const state = {
    version: 1,
    ownerPid: liveOwner.pid,
    daemonPid: null,
    tunnelPid: null,
    status: "ready",
    updatedAt: new Date().toISOString(),
  };
  const serializedState = `${JSON.stringify(state)}\n`;
  fs.mkdirSync(path.dirname(supervisor.statePath), { recursive: true });
  fs.writeFileSync(supervisor.statePath, serializedState);
  let adoptions = 0;
  let tunnelStops = 0;
  supervisor.proxyHealth = async () => false;
  supervisor.adoptConfiguredTunnelForStop = async () => {
    adoptions += 1;
    supervisor.tunnel = { pid: 123_456_789 };
  };
  supervisor.stopTunnelGracefully = async () => {
    tunnelStops += 1;
    supervisor.tunnel = null;
  };
  try {
    await assert.rejects(supervisor.stopForSetup(), /Another launcher process still owns the runtime/);
    assert.equal(adoptions, 0);
    assert.equal(tunnelStops, 0);
    assert.equal(fs.readFileSync(supervisor.statePath, "utf8"), serializedState);
  } finally {
    const ownerExited = exited(liveOwner);
    liveOwner.kill("SIGKILL");
    await ownerExited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
