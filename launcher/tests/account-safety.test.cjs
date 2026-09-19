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
    waitForProxy: async () => { calls.push("wait-for-proxy"); },
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
  return { calls, configPath, host, root, supervisor };
}

test("launcher validates Automatic Web account-safety settings", () => {
  const descriptorPath = path.join(os.tmpdir(), "launcher-browser-account-safety.json");
  for (const [maxBrowserTabs, automaticWebSessionLimitCount, automaticWebSessionLimitMinutes]
    of [[1, 1, 1], [6, 10_000, 10_080]]) {
    assert.doesNotThrow(() => validateConfig(
      configFor(descriptorPath, { maxBrowserTabs, automaticWebSessionLimitCount, automaticWebSessionLimitMinutes }),
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
  for (const automaticWebSessionLimitCount of [0, 10_001, 1.5]) {
    assert.throws(
      () => validateConfig(configFor(descriptorPath, { automaticWebSessionLimitCount }), descriptorPath),
      /automaticWebSessionLimitCount/,
    );
  }
});

test("launcher defaults proactive safety off with a 300 minute first-enable value", () => {
  const descriptorPath = path.join(os.tmpdir(), "launcher-browser-account-safety-default.json");
  const standard = runtimePreferenceState(validateConfig(configFor(descriptorPath), descriptorPath));
  assert.equal(standard.maxBrowserTabs, 5);
  assert.equal(standard.automaticWebSessionLimitEnabled, false);
  assert.equal(standard.automaticWebSessionLimitCount, 15);
  assert.equal(standard.automaticWebSessionLimitMinutes, 300);

  const explicit = runtimePreferenceState(validateConfig(configFor(descriptorPath, {
    automaticWebSessionLimitCount: 50,
    automaticWebSessionLimitMinutes: 300,
  }), descriptorPath));
  assert.equal(explicit.automaticWebSessionLimitEnabled, true);
  assert.equal(explicit.automaticWebSessionLimitCount, 50);

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
    automaticWebSessionLimitCount: 40,
    automaticWebSessionLimitMinutes: 300,
  }), { maxBrowserTabs: 2, automaticWebSessionLimitCount: 40, automaticWebSessionLimitMinutes: 300 });
  let saved = JSON.parse(fs.readFileSync(item.configPath, "utf8"));
  assert.equal(saved.maxBrowserTabs, 2);
  assert.equal(saved.automaticWebSessionLimitCount, 40);
  assert.equal(saved.automaticWebSessionLimitMinutes, 300);
  assert.deepEqual(item.calls, ["stop", "start"]);

  assert.deepEqual(await item.host.setAccountSafetySettings({ maxBrowserTabs: 4 }), {
    maxBrowserTabs: 4,
    automaticWebSessionLimitCount: undefined,
    automaticWebSessionLimitMinutes: undefined,
  });
  saved = JSON.parse(fs.readFileSync(item.configPath, "utf8"));
  assert.equal(saved.maxBrowserTabs, 4);
  assert.equal(saved.automaticWebSessionLimitCount, undefined);
  assert.equal(saved.automaticWebSessionLimitMinutes, undefined);
  assert.deepEqual(item.calls, ["stop", "start", "stop", "start"]);
});

test("launcher serializes account-safety polling before a settings restart", async (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  let releaseStatus;
  const statusBlocked = new Promise(resolve => { releaseStatus = resolve; });
  item.supervisor.waitForProxy = async () => {
    item.calls.push("wait-for-proxy");
    await statusBlocked;
  };

  const status = item.host.accountSafetyStatus();
  await new Promise(resolve => setImmediate(resolve));
  const settings = item.host.setAccountSafetySettings({ maxBrowserTabs: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(item.calls, ["wait-for-proxy"]);

  releaseStatus();
  assert.deepEqual(await status, { state: "PAUSED" });
  assert.deepEqual(await settings, {
    maxBrowserTabs: 2,
    automaticWebSessionLimitCount: undefined,
    automaticWebSessionLimitMinutes: undefined,
  });
  assert.deepEqual(item.calls, ["wait-for-proxy", "account-safety-status", "stop", "start"]);
});

test("launcher delays account-safety polling until a settings restart finishes", async (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  let releaseStop;
  const stopBlocked = new Promise(resolve => { releaseStop = resolve; });
  item.supervisor.stopForSetup = async () => {
    item.calls.push("stop");
    await stopBlocked;
    return { status: "stopped" };
  };

  const settings = item.host.setAccountSafetySettings({ maxBrowserTabs: 2 });
  await new Promise(resolve => setImmediate(resolve));
  const status = item.host.accountSafetyStatus();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(item.calls, ["stop"]);

  releaseStop();
  await settings;
  assert.deepEqual(await status, { state: "PAUSED" });
  assert.deepEqual(item.calls, ["stop", "start", "wait-for-proxy", "account-safety-status"]);
});

test("launcher delays account-safety polling for every Settings restart path", async (t) => {
  for (const [label, restart] of [
    ["Enhanced Web session", host => host.setUseEnhancedWebSessionMode(true)],
    ["Enhanced output tunnel", host => host.setUseEnhancedOutputTunnel(false)],
  ]) {
    await t.test(label, async (t) => {
      const item = fixture();
      t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
      let releaseStop;
      const stopBlocked = new Promise(resolve => { releaseStop = resolve; });
      item.supervisor.stopForSetup = async () => {
        item.calls.push("stop");
        await stopBlocked;
        return { status: "stopped" };
      };

      const setting = restart(item.host);
      await new Promise(resolve => setImmediate(resolve));
      const status = item.host.accountSafetyStatus();
      await new Promise(resolve => setImmediate(resolve));
      try {
        assert.deepEqual(item.calls, ["stop"]);
      } finally {
        releaseStop();
      }
      await setting;
      await status;
      assert.deepEqual(item.calls, ["stop", "start", "wait-for-proxy", "account-safety-status"]);
    });
  }
});

test("launcher releases runtime serialization after a failed account-safety poll", async (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  item.supervisor.waitForProxy = async () => {
    item.calls.push("wait-for-proxy");
    throw new Error("synthetic status failure");
  };

  await assert.rejects(item.host.accountSafetyStatus(), /synthetic status failure/);
  await item.host.setAccountSafetySettings({ maxBrowserTabs: 2 });
  assert.deepEqual(item.calls, ["wait-for-proxy", "stop", "start"]);
});

test("launcher account-safety recovery uses the authenticated runtime control channel", async (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));

  assert.deepEqual(await item.host.accountSafetyStatus(), { state: "PAUSED" });
  assert.deepEqual(await item.host.resetAutomaticWebUsage(), { state: "PAUSED" });
  assert.deepEqual(await item.host.resumeAutomaticWeb(), { state: "PAUSED" });
  assert.deepEqual(await item.host.acknowledgeAccountSafetyStop(), { state: "NORMAL" });
  assert.deepEqual(item.calls, [
    "wait-for-proxy",
    "account-safety-status",
    "account-safety-reset-usage",
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
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");

  assert.match(types, /maxBrowserTabs: number/);
  assert.match(types, /automaticWebSessionLimitCount: number/);
  assert.match(types, /automaticWebSessionLimitMinutes: number/);
  assert.match(preload, /setAccountSafetySettings:.*launcher:account-safety-settings/);
  assert.match(preload, /accountSafetyStatus:.*launcher:account-safety-status/);
  assert.match(preload, /resetAutomaticWebUsage:.*launcher:account-safety-reset-usage/);
  assert.match(main, /runtimeHost\.setAccountSafetySettings\(input\)/);
  assert.match(main, /runtimeHost\.resetAutomaticWebUsage\(\)/);
  assert.match(main, /runtimeHost\.resumeAutomaticWeb\(\)/);
  assert.match(main, /runtimeHost\.acknowledgeAccountSafetyStop\(\)/);
  assert.match(settings, /snapshot\.state\.browserInteractionMode === "automatic" \? <>/);
  assert.match(settings, /account-safety-card/);
  assert.match(settings, /label=\{copy\.accountSafetyLimitToggle\}/);
  assert.match(settings, /aria-label=\{label\}/);
  assert.match(settings, /<strong>\{copy\.accountSafetyUsageMeter\}<\/strong>/);
  assert.match(settings, /const remainingSessions = Math\.max\(0, sessionCapacity - usedSessions\)/);
  assert.match(settings, /copy\.accountSafetySessionsRemaining[\s\S]*copy\.accountSafetyResetIn/);
  assert.match(settings, /aria-valuenow=\{sessionLimitEnabled \? remainingSessions : 0\}/);
  assert.match(settings, /sessionLimitEnabled && remainingPercent < 20 \? " is-low" : ""/);
  assert.match(styles, /\.account-safety-progress\.is-low > span[\s\S]*var\(--red-300\)/);
  assert.match(settings, /window\.setTimeout\([\s\S]*applyAccountSafetySettings[\s\S]*3_000\)/);
  assert.match(settings, /setAccountSafetySaveRetry\(\(retry\) => retry \+ 1\)/);
  assert.match(settings, /accountSafetySaveRetry,[\s\S]*snapshot\.state\.browserInteractionMode/);
  assert.doesNotMatch(settings, /copy\.applyAccountSafety/);
  assert.match(settings, /copy\.resetAccountSafetyUsage/);
  assert.match(settings, /copy\.confirmAccountSafetyReset/);
  assert.match(settings, /copy\.accountSafetyResetHint/);
  assert.match(settings, /api!\.resetAutomaticWebUsage\(\)/);
  assert.match(settings, /if \(busy\) return;[\s\S]*api!\.accountSafetyStatus\(\)/);
  assert.match(settings, /snapshot\.state\.coreSetupComplete,\s*busy,\s*\]\);/);
  assert.match(settings, /resetUsageStage === "confirm"/);
  assert.match(styles, /\.account-safety-progress\.is-resetting::after/);
  assert.match(settings, /aria-valuetext=\{accountSafetyMeterText\}/);
  assert.match(styles, /\.account-safety-progress\.is-low \{[\s\S]*box-shadow:[^;]*var\(--red-300\)/);
  assert.match(settings, /className="settings-card enhanced-feature-card"/);
  assert.match(settings, /<SectionHeading label=\{copy\.general\} spaced \/>/);
  assert.match(settings, /used_sessions/);
  assert.match(settings, /session_limit/);
  assert.match(settings, /accountSafety\?\.state === "PAUSED" && accountSafety\.reason === "rate_limit"/);
  assert.match(settings, /accountSafety\?\.state === "HARD_STOP"/);
});
