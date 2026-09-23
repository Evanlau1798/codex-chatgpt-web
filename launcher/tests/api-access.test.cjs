const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RuntimeHost } = require("../electron/runtime.cjs");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-api-access-"));
  const calls = [];
  const config = { browserHost: "launcher", browserInteractionMode: "automatic", host: "127.0.0.1", port: 17841 };
  const supervisor = {
    coreHome: root,
    readConfig: () => config,
    stopForSetup: async () => { calls.push("stop"); return { status: "stopped" }; },
    startIfConfigured: async () => { calls.push("start"); return { status: "ready" }; },
  };
  const host = new RuntimeHost({
    app: { getPath: () => root }, logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root, browserDescriptorPath: path.join(root, "browser.json"),
    coreHome: root, supervisor,
  });
  return { root, calls, host, supervisor };
}

test("first enable waits for a generated key, then starts the daemon once", async (t) => {
  const { root, calls, host } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(await host.apiAccessStatus(), {
    state: "disabled", endpoint: "http://127.0.0.1:17841/v1", hasKey: false, keyPreview: null,
    firstEnablePending: true,
  });
  assert.equal((await host.setApiAccessEnabled(true)).state, "key_required");
  assert.equal((await host.apiAccessStatus()).firstEnablePending, false);
  assert.deepEqual(calls, []);
  const status = await host.generateApiAccessKey();
  assert.equal(status.state, "enabled");
  assert.equal(status.hasKey, true);
  assert.match(status.keyPreview, /^sk-local-\*+.{5}$/);
  assert.deepEqual(calls, ["stop", "start"]);
  const secret = await host.copyApiAccessKey();
  assert.match(secret, /^sk-local-[A-Za-z0-9_-]{43}$/);
  assert.equal(status.keyPreview.endsWith(secret.slice(-5)), true);
  assert.equal(JSON.stringify(status).includes(secret), false);
  assert.equal(fs.readFileSync(path.join(root, "api-access", "key"), "utf8"), secret);
});

test("disabling preserves the key; reset rotates it and failed restart rolls back", async (t) => {
  const { root, calls, host, supervisor } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await host.setApiAccessEnabled(true);
  await host.generateApiAccessKey();
  const first = await host.copyApiAccessKey();
  assert.equal((await host.setApiAccessEnabled(false)).state, "disabled");
  assert.equal((await host.apiAccessStatus()).firstEnablePending, false);
  assert.equal(await host.copyApiAccessKey(), first);
  await host.setApiAccessEnabled(true);
  const second = await host.resetApiAccessKey();
  assert.equal(second.state, "enabled");
  assert.notEqual(await host.copyApiAccessKey(), first);
  const old = await host.copyApiAccessKey();
  let starts = 0;
  supervisor.startIfConfigured = async () => {
    calls.push("start");
    if (++starts === 1) throw new Error("failed to start");
    return { status: "ready" };
  };
  await assert.rejects(host.resetApiAccessKey(), /failed to start/);
  assert.equal(await host.copyApiAccessKey(), old);
  assert.equal((await host.apiAccessStatus()).state, "enabled");
});

test("API Access first-enable warning is confirmed before activation and remains available as help", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "api-access-card.tsx"), "utf8");
  assert.match(source, /status\?\.firstEnablePending[\s\S]*setShowWarning\(true\)/);
  assert.match(source, /<dialog[\s\S]*aria-labelledby="api-access-warning-title"/);
  assert.match(source, /copy\.apiAccessWarningBody/);
  assert.match(source, /account-safety-help[\s\S]*copy\.apiAccessHelpLabel/);
});

test("API Access is labeled experimental and explains compatibility limits in every language", () => {
  const locales = [
    ["i18n.ts", /experimental/, /unstable/, /compatibility/],
    ["i18n-zh-tw.ts", /實驗性/, /不穩定/, /相容性/],
    ["i18n-ja.ts", /実験的/, /不安定/, /互換性/],
    ["i18n-ko.ts", /실험적/, /불안정/, /호환성/],
  ];
  for (const [file, marker, stability, compatibility] of locales) {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", file), "utf8");
    assert.match(source, new RegExp(`apiAccess: "[^"\\n]*${marker.source}[^"\\n]*"`, "i"));
    assert.match(source, new RegExp(`apiAccessWarningBody: "[^"\\n]*${stability.source}[^"\\n]*"`, "i"));
    assert.match(source, new RegExp(`apiAccessWarningBody: "[^"\\n]*${compatibility.source}[^"\\n]*"`, "i"));
  }
  const simplified = fs.readFileSync(path.join(__dirname, "..", "src", "i18n.ts"), "utf8");
  assert.match(simplified, /apiAccess: "API 访问（实验性）"/);
  assert.match(simplified, /apiAccessWarningBody: "[^"\n]*兼容性[^"\n]*不稳定/);
});

test("only the managed daemon receives the API key, never the tunnel or inherited environment", async (t) => {
  const { root, host } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await host.setApiAccessEnabled(true);
  await host.generateApiAccessKey();
  const key = await host.copyApiAccessKey();
  const supervisor = new RuntimeSupervisor({
    app: {}, logger: { info() {}, warn() {}, error() {} }, sourceRoot: root,
    coreHome: root, browserDescriptorPath: path.join(root, "browser.json"),
  });
  const prior = process.env.CODEX_CHATGPT_WEB_API_KEY;
  process.env.CODEX_CHATGPT_WEB_API_KEY = "inherited-secret";
  try {
    assert.equal(supervisor.childEnvironment("daemon").CODEX_CHATGPT_WEB_API_KEY, key);
    assert.equal(supervisor.childEnvironment("tunnel").CODEX_CHATGPT_WEB_API_KEY, undefined);
    assert.equal(supervisor.childEnvironment("daemon", { browserInteractionMode: "manual" }).CODEX_CHATGPT_WEB_API_KEY, undefined);
    await host.setApiAccessEnabled(false);
    assert.equal(supervisor.childEnvironment("daemon").CODEX_CHATGPT_WEB_API_KEY, undefined);
  } finally {
    if (prior === undefined) delete process.env.CODEX_CHATGPT_WEB_API_KEY;
    else process.env.CODEX_CHATGPT_WEB_API_KEY = prior;
  }
});

test("status and clipboard reads wait for an in-progress key rotation", async (t) => {
  const { root, host, supervisor } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await host.setApiAccessEnabled(true);
  await host.generateApiAccessKey();
  let releaseStart;
  let markEntered;
  const entered = new Promise(resolve => { markEntered = resolve; });
  supervisor.startIfConfigured = () => { markEntered(); return new Promise(resolve => { releaseStart = resolve; }); };
  const rotating = host.resetApiAccessKey();
  await entered;
  const status = Promise.resolve(host.apiAccessStatus());
  const copied = Promise.resolve(host.copyApiAccessKey());
  const beforeCommit = await Promise.race([
    Promise.all([status, copied]).then(() => "exposed"),
    new Promise(resolve => setTimeout(() => resolve("pending"), 10)),
  ]);
  assert.equal(beforeCommit, "pending");
  releaseStart({ status: "ready" });
  await rotating;
  assert.equal((await status).keyPreview.endsWith((await copied).slice(-5)), true);
});

test("Manual mode rejects API key status and clipboard reads at the host boundary", async (t) => {
  const { root, host } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await host.setApiAccessEnabled(true);
  await host.generateApiAccessKey();
  host.getBrowserInteractionMode = () => "manual";
  await assert.rejects(host.apiAccessStatus(), /Automatic Web mode/);
  await assert.rejects(host.copyApiAccessKey(), /Automatic Web mode/);
});

test("failed candidate and failed recovery preserve both failure reasons", async (t) => {
  const { root, host, supervisor } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await host.setApiAccessEnabled(true);
  await host.generateApiAccessKey();
  let attempts = 0;
  supervisor.startIfConfigured = async () => {
    throw new Error(++attempts === 1 ? "candidate start failed" : "recovery start failed");
  };
  await assert.rejects(host.resetApiAccessKey(), error =>
    error.message.includes("candidate start failed") && error.message.includes("recovery start failed"));
});
