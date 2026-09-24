const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RuntimeHost } = require("../electron/runtime.cjs");
const { shouldRunFileSymlinkTests } = require("../../tests/support/symlink-capability.cjs");
const testFileSymlinks = shouldRunFileSymlinkTests();

test("failed first-time combined setup removes its routes before restoring the unconfigured state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-first-setup-rollback-"));
  const coreHome = path.join(root, "core");
  const codexHome = path.join(root, "codex");
  const journalPath = path.join(coreHome, "codex", "integration-journal.json");
  const recoveryJournalPath = path.join(coreHome, "codex", "integration-journal.recovery.json");
  const configPath = path.join(root, "config.json");
  const codexConfigPath = path.join(codexHome, "config.toml");
  const codexModelsCachePath = path.join(codexHome, "models_cache.json");
  const claudeSettingsPath = path.join(root, ".claude", "settings.json");
  const claudeJournalPath = path.join(coreHome, "claude", "integration-journal.json");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.dirname(claudeSettingsPath), { recursive: true });
  fs.writeFileSync(codexConfigPath, "original codex config\n");
  fs.writeFileSync(codexModelsCachePath, "original codex models cache\n");
  fs.writeFileSync(claudeSettingsPath, "original claude settings\n");
  let cleared = 0;
  let stops = 0;
  const calls = [];
  const setupError = new Error("synthetic setup failure");
  const supervisor = {
    coreHome,
    configPath,
    readConfig: () => fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : null,
    readSetupConfig: () => fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : null,
    stopForSetup: async () => {
      stops += 1;
      return { status: "stopped" };
    },
    startIfConfigured: async () => ({ status: fs.existsSync(configPath) ? "ready" : "not-configured" }),
    clearState: () => { cleared += 1; },
  };
  const host = new RuntimeHost({
    app: { getPath: () => root },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: path.join(root, "launcher-browser.json"),
    codexHome,
    supervisor,
  });
  host.run = async (_name, args) => {
    calls.push(args);
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify({ mode: "browser-only", browserHost: "launcher" })}\n`);
    fs.writeFileSync(journalPath, "partial integration journal\n");
    fs.mkdirSync(path.dirname(claudeJournalPath), { recursive: true });
    fs.writeFileSync(claudeJournalPath, "partial claude integration journal\n");
    fs.writeFileSync(claudeSettingsPath, "partially changed claude settings\n");
    fs.writeFileSync(recoveryJournalPath, "partial recovery journal\n");
    fs.writeFileSync(codexConfigPath, "partially changed codex config\n");
    fs.rmSync(codexModelsCachePath);
    throw setupError;
  };
  try {
    await assert.rejects(
      host.runSetup("core-setup", ["setup", "--browser-only", "--all-integrations"], {}),
      error => {
        assert.match(error.message, /synthetic setup failure; incomplete first-time setup was rolled back/);
        assert.equal(error.cause, setupError);
        return true;
      },
    );
    assert.deepEqual(calls.map((args) => args.includes("--preflight-only") ? "preflight" : args[0]), ["preflight", "setup"]);
    assert.equal(fs.existsSync(configPath), false);
    assert.equal(fs.existsSync(journalPath), false);
    assert.equal(fs.existsSync(recoveryJournalPath), false);
    assert.equal(fs.readFileSync(codexConfigPath, "utf8"), "original codex config\n");
    assert.equal(fs.readFileSync(codexModelsCachePath, "utf8"), "original codex models cache\n");
    assert.equal(fs.readFileSync(claudeSettingsPath, "utf8"), "original claude settings\n");
    assert.equal(fs.existsSync(claudeJournalPath), false);
    assert.equal(stops, 2);
    assert.equal(cleared, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed setup preflight leaves the previous runtime running and untouched", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-setup-preflight-"));
  const configPath = path.join(root, "config.json");
  const config = { mode: "browser-only", browserHost: "launcher", releaseVersion: "4.0.7" };
  fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  let stops = 0;
  let starts = 0;
  const host = new RuntimeHost({
    app: { getPath: () => root },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: path.join(root, "launcher-browser.json"),
    codexHome: path.join(root, "codex"),
    supervisor: {
      configPath,
      readSetupConfig: () => config,
      readConfig: () => config,
      stopForSetup: async () => { stops += 1; },
      startIfConfigured: async () => { starts += 1; return { status: "needs-setup" }; },
    },
  });
  host.run = async (_name, args) => {
    assert.equal(args.includes("--preflight-only"), true);
    throw new Error("multi_agent_v2 in Codex [features] is unsupported");
  };
  try {
    await assert.rejects(
      host.runSetup("runtime-upgrade", ["setup", "--browser-only"], {}),
      /multi_agent_v2 in Codex \[features\] is unsupported$/,
    );
    assert.equal(stops, 0);
    assert.equal(starts, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), config);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("launcher delegates an existing terminal-managed installation to the migration-aware CLI", async () => {
  let config = { mode: "full", browserHost: "managed-chrome", releaseVersion: "0.1.16" };
  let prepared = 0;
  let launcherStops = 0;
  const coreHome = path.join(os.tmpdir(), "codex-web-gpt-runtime-host-migration-core");
  const supervisor = {
    coreHome,
    configPath: path.join(coreHome, "config.json"),
    readSetupConfig: () => config,
    readConfig: () => {
      if (config.browserHost !== "launcher") throw new Error("not launcher-owned");
      return config;
    },
    prepareExternalMigration: () => { prepared += 1; },
    stopForSetup: async () => { launcherStops += 1; },
    startIfConfigured: async () => ({ status: "ready" }),
  };
  const host = new RuntimeHost({
    app: { getPath: () => path.join(os.tmpdir(), "codex-web-gpt-runtime-host-migration") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    codexHome: path.join(coreHome, "codex"),
    launchAgentsDir: path.join(coreHome, "LaunchAgents"),
    supervisor,
  });
  host.run = async (_name, args) => {
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    config = { mode: "full", browserHost: "launcher", releaseVersion: "0.2.0" };
    return { code: 0, stdout: "", stderr: "" };
  };

  await host.runSetup("core-setup", ["setup", "--full"], {});
  assert.equal(prepared, 1);
  assert.equal(launcherStops, 0);
});

test("failed terminal migration verifies the unchanged previous runtime instead of claiming recovery", async () => {
  const config = { mode: "browser-only", browserHost: "managed-chrome", releaseVersion: "0.1.16" };
  const calls = [];
  const coreHome = path.join(os.tmpdir(), "codex-web-gpt-runtime-host-migration-failure-core");
  const host = new RuntimeHost({
    app: { getPath: () => path.join(os.tmpdir(), "codex-web-gpt-runtime-host-migration-failure") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    codexHome: path.join(coreHome, "codex"),
    launchAgentsDir: path.join(coreHome, "LaunchAgents"),
    supervisor: {
      coreHome,
      configPath: path.join(coreHome, "config.json"),
      readSetupConfig: () => config,
      readConfig: () => { throw new Error("not launcher-owned"); },
      prepareExternalMigration() {},
    },
  });
  host.run = async (_name, args) => {
    calls.push(args.includes("--preflight-only") ? "preflight" : args[0]);
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "setup") throw new Error("synthetic migration failure");
    return { code: 0, stdout: '{"ok":true}', stderr: "" };
  };

  await assert.rejects(
    host.runSetup("core-setup", ["setup", "--browser-only"], {}),
    /synthetic migration failure$/,
  );
  assert.deepEqual(calls, ["preflight", "setup", "doctor"]);
});

test("failed launcher update restores every mutable setup file before restarting the previous runtime", { skip: !testFileSymlinks }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-setup-checkpoint-"));
  const coreHome = path.join(root, "core");
  const codexHome = path.join(root, "codex");
  const configPath = path.join(coreHome, "config.json");
  const journalPath = path.join(coreHome, "codex", "integration-journal.json");
  const recoveryJournalPath = path.join(coreHome, "codex", "integration-journal.recovery.json");
  const keyPath = path.join(coreHome, "secrets", "tunnel-runtime.key");
  const profileDir = path.join(coreHome, "tunnel", "profiles");
  const profilePath = path.join(profileDir, "custom.yaml");
  const codexConfigPath = path.join(codexHome, "config.toml");
  const sharedDirectory = path.join(root, "shared");
  const sharedConfigPath = path.join(sharedDirectory, "config.toml");
  const codexModelsCachePath = path.join(codexHome, "models_cache.json");
  const oldConfig = {
    mode: "full",
    browserHost: "launcher",
    releaseVersion: "0.1.16",
    tunnel: {
      runtimeKeyFile: keyPath,
      profileDir,
      profileName: "custom",
    },
  };
  for (const file of [configPath, journalPath, recoveryJournalPath, keyPath, profilePath, codexConfigPath, codexModelsCachePath]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.writeFileSync(configPath, `${JSON.stringify(oldConfig)}\n`, { mode: 0o600 });
  fs.writeFileSync(journalPath, "old journal\n", { mode: 0o600 });
  fs.writeFileSync(recoveryJournalPath, "old recovery journal\n", { mode: 0o600 });
  fs.writeFileSync(keyPath, "old key\n", { mode: 0o600 });
  fs.writeFileSync(profilePath, "old profile\n", { mode: 0o600 });
  fs.mkdirSync(sharedDirectory, { mode: 0o750 });
  fs.writeFileSync(sharedConfigPath, "old codex config\n", { mode: 0o640 });
  fs.symlinkSync(sharedConfigPath, codexConfigPath);
  const linkTarget = fs.readlinkSync(codexConfigPath);
  const linkInode = fs.lstatSync(codexConfigPath).ino;
  const directoryMode = fs.statSync(sharedDirectory).mode & 0o777;
  const fileMode = fs.statSync(sharedConfigPath).mode & 0o777;
  fs.writeFileSync(codexModelsCachePath, "old codex models cache\n", { mode: 0o600 });

  let startAttempts = 0;
  const readConfig = () => JSON.parse(fs.readFileSync(configPath, "utf8"));
  const supervisor = {
    coreHome,
    configPath,
    readSetupConfig: readConfig,
    readConfig,
    stopForSetup: async () => ({ status: "stopped" }),
    startIfConfigured: async () => {
      startAttempts += 1;
      if (readConfig().releaseVersion !== oldConfig.releaseVersion) {
        throw new Error("synthetic updated runtime startup failure");
      }
      return { status: "ready" };
    },
  };
  const host = new RuntimeHost({
    app: { getPath: () => path.join(root, "launcher") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: path.join(coreHome, "runtime", "launcher-browser.json"),
    codexHome,
    supervisor,
  });
  host.run = async (_name, args) => {
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    fs.writeFileSync(configPath, `${JSON.stringify({ ...oldConfig, releaseVersion: "0.2.0" })}\n`);
    fs.writeFileSync(journalPath, "new journal\n");
    fs.writeFileSync(recoveryJournalPath, "new recovery journal\n");
    fs.writeFileSync(keyPath, "new key\n");
    fs.writeFileSync(profilePath, "new profile\n");
    fs.writeFileSync(codexConfigPath, "new codex config\n");
    fs.rmSync(codexModelsCachePath);
    return { code: 0, stdout: "", stderr: "" };
  };

  try {
    await assert.rejects(
      host.runSetup("core-setup", ["setup", "--full"], {}),
      /synthetic updated runtime startup failure$/,
    );
    assert.equal(startAttempts, 2);
    assert.deepEqual(readConfig(), oldConfig);
    assert.equal(fs.readFileSync(journalPath, "utf8"), "old journal\n");
    assert.equal(fs.readFileSync(recoveryJournalPath, "utf8"), "old recovery journal\n");
    assert.equal(fs.readFileSync(keyPath, "utf8"), "old key\n");
    assert.equal(fs.readFileSync(profilePath, "utf8"), "old profile\n");
    assert.equal(fs.readFileSync(codexConfigPath, "utf8"), "old codex config\n");
    assert.equal(fs.lstatSync(codexConfigPath).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(codexConfigPath).ino, linkInode);
    assert.equal(fs.readlinkSync(codexConfigPath), linkTarget);
    assert.equal(fs.statSync(sharedDirectory).mode & 0o777, directoryMode);
    assert.equal(fs.statSync(sharedConfigPath).mode & 0o777, fileMode);
    assert.equal(fs.readFileSync(codexModelsCachePath, "utf8"), "old codex models cache\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed terminal migration restores removed launchd ownership before verifying the old runtime", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-terminal-checkpoint-"));
  const coreHome = path.join(root, "core");
  const codexHome = path.join(root, "codex");
  const launchAgentsDir = path.join(root, "LaunchAgents");
  const configPath = path.join(coreHome, "config.json");
  const daemonPlist = path.join(launchAgentsDir, "io.github.codex-chatgpt-web.daemon.plist");
  const tunnelPlist = path.join(launchAgentsDir, "io.github.codex-chatgpt-web.tunnel.plist");
  const oldConfig = {
    mode: "full",
    browserHost: "managed-chrome",
    releaseVersion: "0.1.16",
  };
  for (const file of [configPath, daemonPlist, tunnelPlist]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.writeFileSync(configPath, `${JSON.stringify(oldConfig)}\n`, { mode: 0o600 });
  fs.writeFileSync(daemonPlist, "old daemon plist\n", { mode: 0o600 });
  fs.writeFileSync(tunnelPlist, "old tunnel plist\n", { mode: 0o600 });

  let startAttempts = 0;
  const calls = [];
  const readConfig = () => JSON.parse(fs.readFileSync(configPath, "utf8"));
  const supervisor = {
    coreHome,
    configPath,
    readSetupConfig: readConfig,
    readConfig: () => {
      const config = readConfig();
      if (config.browserHost !== "launcher") throw new Error("not launcher-owned");
      return config;
    },
    prepareExternalMigration() {},
    startIfConfigured: async () => {
      startAttempts += 1;
      throw new Error("synthetic launcher startup failure");
    },
  };
  const host = new RuntimeHost({
    app: { getPath: () => path.join(root, "launcher") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: path.join(coreHome, "runtime", "launcher-browser.json"),
    codexHome,
    launchAgentsDir,
    platform: "darwin",
    supervisor,
  });
  host.run = async (_name, args) => {
    calls.push(args.join(" "));
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "setup") {
      fs.writeFileSync(configPath, `${JSON.stringify({ ...oldConfig, browserHost: "launcher", releaseVersion: "0.2.0" })}\n`);
      fs.rmSync(daemonPlist);
      fs.rmSync(tunnelPlist);
    }
    return { code: 0, stdout: args[0] === "doctor" ? '{"ok":true}' : "", stderr: "" };
  };

  try {
    await assert.rejects(
      host.runSetup("core-setup", ["setup", "--full"], {}),
      /synthetic launcher startup failure$/,
    );
    assert.equal(startAttempts, 1);
    assert.deepEqual(readConfig(), oldConfig);
    assert.equal(fs.readFileSync(daemonPlist, "utf8"), "old daemon plist\n");
    assert.equal(fs.readFileSync(tunnelPlist, "utf8"), "old tunnel plist\n");
    assert.deepEqual(calls, [
      "setup --full --codex-only --preflight-only",
      "setup --full --codex-only",
      "service install",
      "tunnel start",
      "doctor --json",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("setup preflight keeps the requested setup budget before stopping the current runtime", async () => {
  const events = [];
  const host = new RuntimeHost({
    app: { getPath: () => os.tmpdir() },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor: {
      readSetupConfig: () => null,
      readConfig: () => null,
      stopForSetup: async () => { events.push("stop"); },
      startIfConfigured: async () => { events.push("start"); return { status: "ready" }; },
    },
  });
  host.captureSetupCheckpoint = () => [];
  host.run = async (_name, args, options) => {
    events.push(args.includes("--preflight-only") ? "preflight" : "setup");
    assert.equal(options.timeoutMs, 300_000);
    return { code: 0, stdout: "", stderr: "" };
  };
  await host.runSetup("core-setup", ["setup", "--full"], { timeoutMs: 300_000 });
  assert.deepEqual(events, ["preflight", "stop", "setup", "start"]);
});


test("failed fresh-conversation setting restores every mutable setup file before restarting the previous runtime", { skip: !testFileSymlinks }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-setup-checkpoint-"));
  const coreHome = path.join(root, "core");
  const codexHome = path.join(root, "codex");
  const configPath = path.join(coreHome, "config.json");
  const journalPath = path.join(coreHome, "codex", "integration-journal.json");
  const recoveryJournalPath = path.join(coreHome, "codex", "integration-journal.recovery.json");
  const keyPath = path.join(coreHome, "secrets", "tunnel-runtime.key");
  const profileDir = path.join(coreHome, "tunnel", "profiles");
  const profilePath = path.join(profileDir, "custom.yaml");
  const codexConfigPath = path.join(codexHome, "config.toml");
  const sharedDirectory = path.join(root, "shared");
  const sharedConfigPath = path.join(sharedDirectory, "config.toml");
  const codexModelsCachePath = path.join(codexHome, "models_cache.json");
  const oldConfig = {
    mode: "full",
    browserHost: "launcher",
    browserInteractionMode: "automatic",
    experimentalFreshConversationPerTurn: false,
    releaseVersion: "0.1.16",
    tunnel: {
      runtimeKeyFile: keyPath,
      profileDir,
      profileName: "custom",
    },
  };
  for (const file of [configPath, journalPath, recoveryJournalPath, keyPath, profilePath, codexConfigPath, codexModelsCachePath]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.writeFileSync(configPath, `${JSON.stringify(oldConfig)}\n`, { mode: 0o600 });
  fs.writeFileSync(journalPath, "old journal\n", { mode: 0o600 });
  fs.writeFileSync(recoveryJournalPath, "old recovery journal\n", { mode: 0o600 });
  fs.writeFileSync(keyPath, "old key\n", { mode: 0o600 });
  fs.writeFileSync(profilePath, "old profile\n", { mode: 0o600 });
  fs.mkdirSync(sharedDirectory, { mode: 0o750 });
  fs.writeFileSync(sharedConfigPath, "old codex config\n", { mode: 0o640 });
  fs.symlinkSync(sharedConfigPath, codexConfigPath);
  const linkTarget = fs.readlinkSync(codexConfigPath);
  const linkInode = fs.lstatSync(codexConfigPath).ino;
  const directoryMode = fs.statSync(sharedDirectory).mode & 0o777;
  const fileMode = fs.statSync(sharedConfigPath).mode & 0o777;
  fs.writeFileSync(codexModelsCachePath, "old codex models cache\n", { mode: 0o600 });

  let startAttempts = 0;
  const readConfig = () => JSON.parse(fs.readFileSync(configPath, "utf8"));
  const supervisor = {
    coreHome,
    configPath,
    readSetupConfig: readConfig,
    readConfig,
    stopForSetup: async () => ({ status: "stopped" }),
    startIfConfigured: async () => {
      startAttempts += 1;
      if (readConfig().releaseVersion !== oldConfig.releaseVersion) {
        throw new Error("synthetic updated runtime startup failure");
      }
      return { status: "ready" };
    },
  };
  const host = new RuntimeHost({
    app: { getPath: () => path.join(root, "launcher") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: path.join(coreHome, "runtime", "launcher-browser.json"),
    codexHome,
    supervisor,
  });
  host.run = async (_name, args) => {
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    fs.writeFileSync(configPath, `${JSON.stringify({ ...oldConfig, releaseVersion: "0.2.0", experimentalFreshConversationPerTurn: true })}\n`);
    fs.writeFileSync(journalPath, "new journal\n");
    fs.writeFileSync(recoveryJournalPath, "new recovery journal\n");
    fs.writeFileSync(keyPath, "new key\n");
    fs.writeFileSync(profilePath, "new profile\n");
    fs.writeFileSync(codexConfigPath, "new codex config\n");
    fs.rmSync(codexModelsCachePath);
    return { code: 0, stdout: "", stderr: "" };
  };

  try {
    await assert.rejects(
      host.setFreshConversationPerTurn(true),
      /synthetic updated runtime startup failure$/,
    );
    assert.equal(startAttempts, 2);
    assert.deepEqual(readConfig(), oldConfig);
    assert.equal(fs.readFileSync(journalPath, "utf8"), "old journal\n");
    assert.equal(fs.readFileSync(recoveryJournalPath, "utf8"), "old recovery journal\n");
    assert.equal(fs.readFileSync(keyPath, "utf8"), "old key\n");
    assert.equal(fs.readFileSync(profilePath, "utf8"), "old profile\n");
    assert.equal(fs.readFileSync(codexConfigPath, "utf8"), "old codex config\n");
    assert.equal(fs.lstatSync(codexConfigPath).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(codexConfigPath).ino, linkInode);
    assert.equal(fs.readlinkSync(codexConfigPath), linkTarget);
    assert.equal(fs.statSync(sharedDirectory).mode & 0o777, directoryMode);
    assert.equal(fs.statSync(sharedConfigPath).mode & 0o777, fileMode);
    assert.equal(fs.readFileSync(codexModelsCachePath, "utf8"), "old codex models cache\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
