const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RuntimeHost } = require("../electron/runtime.cjs");
const { validateConfig } = require("../electron/runtime-supervisor.cjs");
const { runtimePreferenceState } = require("../electron/runtime-setup-state.cjs");

function configFor(descriptorPath, overrides = {}) {
  const root = path.dirname(descriptorPath);
  return {
    version: 3,
    releaseVersion: "4.0.7-Enhanced.2",
    mode: "browser-only",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native2",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    chromeExecutablePath: process.execPath,
    storageStatePath: path.join(root, "storage-state.json"),
    brokerSocketPath: process.platform === "win32"
      ? "\\\\.\\pipe\\codex-chatgpt-web-account-safety-test"
      : path.join(root, "turn-broker.sock"),
    headed: true,
    solAvailable: true,
    proAvailable: true,
    autoApproveToolCalls: false,
    controlToken: "account-safety-control-token-0123456789abcdef",
    runtimeCommand: [process.execPath],
    ...overrides,
  };
}

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-account-safety-"));
  const descriptorPath = path.join(root, "launcher-browser.json");
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, `${JSON.stringify(configFor(descriptorPath, overrides), null, 2)}\n`);
  const calls = [];
  const read = () => validateConfig(JSON.parse(fs.readFileSync(configPath, "utf8")), descriptorPath);
  const supervisor = {
    configPath,
    readConfig: read,
    readSetupConfig: read,
    stopForSetup: async () => { calls.push("stop"); return { status: "stopped" }; },
    startIfConfigured: async () => { calls.push("start"); return { status: "ready" }; },
    control: async (_config, action) => {
      calls.push(action);
      return { account_safety: { state: action.includes("acknowledge") ? "NORMAL" : "PAUSED" } };
    },
  };
  const host = new RuntimeHost({
    app: { getPath: () => root },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    browserDescriptorPath: descriptorPath,
    supervisor,
  });
  return { calls, configPath, host, root };
}

test("launcher validates Automatic Web account-safety settings", () => {
  const descriptorPath = path.join(os.tmpdir(), "launcher-browser-account-safety.json");
  for (const [maxBrowserTabs, automaticWebSessionLimitMinutes] of [[1, 1], [6, 10_080]]) {
    assert.doesNotThrow(() => validateConfig(
      configFor(descriptorPath, { maxBrowserTabs, automaticWebSessionLimitMinutes }),
      descriptorPath,
    ));
  }
  for (const maxBrowserTabs of [0, 7, 1.5]) {
    assert.throws(() => validateConfig(configFor(descriptorPath, { maxBrowserTabs }), descriptorPath), /maxBrowserTabs/);
  }
  for (const automaticWebSessionLimitMinutes of [0, 10_081, 1.5]) {
    assert.throws(
      () => validateConfig(configFor(descriptorPath, { automaticWebSessionLimitMinutes }), descriptorPath),
      /automaticWebSessionLimitMinutes/,
    );
  }
});

test("launcher defaults proactive safety off with a 300 minute first-enable value", () => {
  const descriptorPath = path.join(os.tmpdir(), "launcher-browser-account-safety-default.json");
  const standard = runtimePreferenceState(validateConfig(configFor(descriptorPath), descriptorPath));
  assert.equal(standard.maxBrowserTabs, 5);
  assert.equal(standard.automaticWebSessionLimitEnabled, false);
  assert.equal(standard.automaticWebSessionLimitMinutes, 300);

  const enhanced = runtimePreferenceState(validateConfig(
    configFor(descriptorPath, { useEnhancedWebSessionMode: true }),
    descriptorPath,
  ));
  assert.equal(enhanced.maxBrowserTabs, 6);
});

test("launcher applies account-safety settings in one runtime restart and can disable the proactive limit", async (t) => {
  const item = fixture({ useEnhancedWebSessionMode: true });
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));

  assert.deepEqual(await item.host.setAccountSafetySettings({
    maxBrowserTabs: 2,
    automaticWebSessionLimitMinutes: 300,
  }), { maxBrowserTabs: 2, automaticWebSessionLimitMinutes: 300 });
  let saved = JSON.parse(fs.readFileSync(item.configPath, "utf8"));
  assert.equal(saved.maxBrowserTabs, 2);
  assert.equal(saved.automaticWebSessionLimitMinutes, 300);
  assert.deepEqual(item.calls, ["stop", "start"]);

  assert.deepEqual(await item.host.setAccountSafetySettings({ maxBrowserTabs: 4 }), {
    maxBrowserTabs: 4,
    automaticWebSessionLimitMinutes: undefined,
  });
  saved = JSON.parse(fs.readFileSync(item.configPath, "utf8"));
  assert.equal(saved.maxBrowserTabs, 4);
  assert.equal(saved.automaticWebSessionLimitMinutes, undefined);
  assert.deepEqual(item.calls, ["stop", "start", "stop", "start"]);
});

test("launcher account-safety recovery uses the authenticated runtime control channel", async (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));

  assert.deepEqual(await item.host.accountSafetyStatus(), { state: "PAUSED" });
  assert.deepEqual(await item.host.resumeAutomaticWeb(), { state: "PAUSED" });
  assert.deepEqual(await item.host.acknowledgeAccountSafetyStop(), { state: "NORMAL" });
  assert.deepEqual(item.calls, [
    "account-safety-status",
    "account-safety-resume",
    "account-safety-acknowledge",
  ]);
});

test("launcher exposes Automatic-only account safety through renderer and IPC", () => {
  const root = path.join(__dirname, "..");
  const settings = fs.readFileSync(path.join(root, "src", "settings-surface.tsx"), "utf8");
  const types = fs.readFileSync(path.join(root, "src", "types.ts"), "utf8");
  const main = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(root, "electron", "preload.cjs"), "utf8");

  assert.match(types, /maxBrowserTabs: number/);
  assert.match(types, /automaticWebSessionLimitMinutes: number/);
  assert.match(preload, /setAccountSafetySettings:.*launcher:account-safety-settings/);
  assert.match(preload, /accountSafetyStatus:.*launcher:account-safety-status/);
  assert.match(main, /runtimeHost\.setAccountSafetySettings\(input\)/);
  assert.match(main, /runtimeHost\.resumeAutomaticWeb\(\)/);
  assert.match(main, /runtimeHost\.acknowledgeAccountSafetyStop\(\)/);
  assert.match(settings, /snapshot\.state\.browserInteractionMode === "automatic" \? <>/);
  assert.match(settings, /accountSafety\?\.state === "PAUSED"/);
  assert.match(settings, /accountSafety\?\.state === "HARD_STOP"/);
});
