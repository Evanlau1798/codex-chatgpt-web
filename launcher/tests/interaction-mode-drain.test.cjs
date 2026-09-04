const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const { once } = require("node:events");
const { RuntimeHost } = require("../electron/runtime.cjs");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

function fixture({ browserTurns = 0, drainError, resumeError, resumeReply, malformed = false } = {}) {
  const events = [];
  const config = { mode: "full", browserHost: "launcher", browserInteractionMode: "manual",
    appName: "Codex Zero Risk", automaticAppName: "Codex Native2", manualAppName: "Codex Zero Risk" };
  const common = { app: { getPath: () => process.cwd(), getVersion: () => "5.0.0" },
    logger: { info() {}, warn() {}, error() {} }, sourceRoot: process.cwd(), coreHome: process.cwd() };
  const supervisor = new RuntimeSupervisor(common);
  supervisor.readConfig = supervisor.readSetupConfig = () => config;
  supervisor.readState = () => null;
  supervisor.proxyHealth = async () => true;
  supervisor.daemon = { pid: process.pid, exitCode: null, signalCode: null };
  supervisor.tunnel = { pid: process.pid };
  supervisor.control = async (_config, action) => {
    events.push(action);
    if (action === "drain-if-idle") throw new Error("HTTP turn is still active");
    if (action === "resume") {
      if (resumeError) throw resumeError;
      return resumeReply ?? { status: "ok", accepting_turns: true };
    }
    if (action === "cancel-turns-if-browser-idle") return { status: "ok", browser_idle: true, cancelled_http_turns: 1,
      cancelled_browser_turns: 0, active_http_turns: 0, active_browser_turns: 0 };
    assert.equal(action, "drain");
    if (drainError) throw drainError;
    return { status: "ok", accepting_turns: false, active_http_turns: 1,
      active_browser_turns: malformed ? undefined : browserTurns };
  };
  supervisor.stopTunnelGracefully = async () => { events.push("stop-tunnel"); supervisor.tunnel = null; };
  supervisor.shutdownDaemon = async () => { events.push("stop-daemon"); supervisor.daemon = null; };
  supervisor.clearState = () => { events.push("clear"); };
  supervisor.tryWriteState = () => {};
  supervisor.ownedRuntimeReady = async () => true;
  supervisor.startIfConfigured = async () => { events.push("start"); return { status: "ready" }; };
  const host = new RuntimeHost({ ...common, supervisor, browserDescriptorPath: "browser.json" });
  host.captureSetupCheckpoint = () => ({});
  host.setupCheckpointChanged = () => false;
  host.restoreSetupCheckpoint = () => { events.push("restore-config"); };
  host.restorePreviousRuntime = async () => { events.push("recover"); };
  host.run = async (_name, args) => {
    events.push(args.includes("--preflight-only") ? "preflight" : "setup");
    return { stdout: "configured" };
  };
  return { host, supervisor, events };
}

for (const mode of ["automatic", "manual"]) {
  test(`interaction switch to ${mode} drains without waiting for HTTP-only work`, async () => {
    const f = fixture();
    await f.host.setBrowserInteractionMode(mode);
    assert.deepEqual(f.events, ["preflight", "drain", "cancel-turns-if-browser-idle", "stop-tunnel", "stop-daemon", "clear", "setup", "start"]);
    assert.equal(f.host.currentOperation(), null);
    assert.equal(f.supervisor.stopping, false);
  });
}

test("interaction switch refuses real browser activity and compensates the drain", async () => {
  const f = fixture({ browserTurns: 1 });
  await assert.rejects(f.host.setBrowserInteractionMode("automatic"), /active browser/);
  assert.deepEqual(f.events, ["preflight", "drain", "resume", "restore-config", "recover"]);
  assert.notEqual(f.supervisor.daemon, null);
  assert.notEqual(f.supervisor.tunnel, null);
});

for (const options of [{ malformed: true }, { drainError: new Error("delivery uncertain") }]) {
  test(`interaction switch fails closed on ${options.malformed ? "malformed" : "uncertain"} drain`, async () => {
    const f = fixture(options);
    await assert.rejects(f.host.setBrowserInteractionMode("automatic"), /browser|uncertain/);
    assert.deepEqual(f.events, ["preflight", "drain", "resume", "restore-config", "recover"]);
  });
}

test("interaction switch preserves a failed resume diagnostic", async () => {
  const f = fixture({ browserTurns: 1, resumeError: new Error("resume unavailable") });
  await assert.rejects(f.host.setBrowserInteractionMode("automatic"), /active browser.*resume unavailable/);
  assert.equal(f.events.includes("stop-daemon"), false);
});

for (const resumeReply of [{ status: "refused", accepting_turns: false }, { status: "ok" }]) {
  test(`interaction switch rejects an unacknowledged resume: ${JSON.stringify(resumeReply)}`, async () => {
    const f = fixture({ browserTurns: 1, resumeReply });
    await assert.rejects(f.host.setBrowserInteractionMode("automatic"), /active browser.*compensating resume failed/);
    assert.equal(f.events.includes("stop-daemon"), false);
  });
}

test("ordinary setup still requires atomic HTTP and browser idleness", async () => {
  const f = fixture();
  await assert.rejects(f.host.runSetup("setup", ["setup"], {}), /HTTP turn is still active/);
  assert.equal(f.events.includes("drain-if-idle"), true);
  assert.equal(f.events.includes("drain"), false);
  assert.equal(f.events.includes("stop-daemon"), false);
});

test("interaction switch uses the authenticated drain endpoint with HTTP-only work", async () => {
  const f = fixture();
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture-control-token");
    assert.equal(request.method, "POST");
    assert.ok(["/admin/drain", "/admin/cancel-turns-if-browser-idle"].includes(request.url));
    f.events.push(request.url === "/admin/drain" ? "http-drain" : "http-cancel");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "ok", browser_idle: true, accepting_turns: false,
      active_http_turns: request.url === "/admin/drain" ? 2 : 0, active_browser_turns: 0,
      cancelled_http_turns: 2, cancelled_browser_turns: 0 }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  Object.assign(f.supervisor.readConfig(), { host: "127.0.0.1", port: server.address().port,
    controlToken: "fixture-control-token" });
  delete f.supervisor.control;
  try {
    await f.host.setBrowserInteractionMode("automatic");
    assert.deepEqual(f.events, ["preflight", "http-drain", "http-cancel", "stop-tunnel", "stop-daemon", "clear", "setup", "start"]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
