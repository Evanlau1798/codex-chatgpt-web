const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RuntimeHost } = require("../electron/runtime.cjs");

async function fixture(run, { selectedClaude = false, managedClaude = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-target-"));
  const core = path.join(root, "core");
  const claude = path.join(root, "claude");
  const settings = path.join(claude, "settings.json");
  const journal = path.join(core, "claude", "integration-journal.json");
  fs.mkdirSync(core); fs.mkdirSync(claude);
  // An unreadable unselected settings path must not block Codex setup or rollback.
  if (selectedClaude || managedClaude) fs.writeFileSync(settings, '{"model":"existing"}\n');
  else fs.mkdirSync(settings);
  if (managedClaude) {
    fs.mkdirSync(path.dirname(journal));
    fs.writeFileSync(journal, '{"version":1}\n');
  }
  const config = { mode: "full", browserHost: "launcher", appName: "Codex Native2",
    releaseVersion: "old", browserInteractionMode: "automatic" };
  const configPath = path.join(core, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  const calls = [];
  const host = new RuntimeHost({
    app: { getPath: () => root, getVersion: () => "new" },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root, browserDescriptorPath: path.join(root, "browser.json"),
    coreHome: core, codexHome: path.join(root, "codex"),
    supervisor: { coreHome: core, configPath, readConfig: () => config, readSetupConfig: () => config,
      stopForSetup: async () => {}, startIfConfigured: async () => ({ status: "ready" }) },
    getBrowserInteractionMode: () => config.browserInteractionMode,
  });
  host.claudeHome = claude;
  host.mcpCredentialsConfigured = () => true;
  host.run = async (_name, args) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify({ active: true, installed: true }), stderr: "" };
  };
  try { await run({ host, calls, config, settings, journal }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

for (const operation of ["setupCore", "setupMcp", "setBiggerContext", "setExperimentalNoAutoCompact",
  "setBrowserInteractionMode", "setZeroRiskPro", "upgradeManagedRuntime"]) {
  test(`${operation} only targets Codex when Claude was not installed`, async () => {
    await fixture(async ({ host, calls, config, settings, journal }) => {
      if (operation === "setZeroRiskPro") config.browserInteractionMode = "manual";
      await host[operation](operation === "setBrowserInteractionMode" ? "manual"
        : /^set[A-Z]/.test(operation) ? false : undefined);
      const setupCalls = calls.filter(args => args[0] === "setup");
      assert.equal(setupCalls.length, 2);
      assert.ok(setupCalls.every(args => args.includes("--codex-only")));
      assert.equal(fs.statSync(settings).isDirectory(), true);
      assert.equal(fs.existsSync(journal), false);
    });
  });
}

for (const target of ["claude", "all"]) {
  test(`explicit ${target} setup retains its target through preflight and execution`, async () => {
    await fixture(async ({ host, calls }) => {
      await host.setupCore(target);
      assert.equal(calls.length, 2);
      assert.ok(calls.every(args => args.includes(target === "claude" ? "--claude-only" : "--all-integrations")));
      assert.ok(calls.every(args => !args.includes("--codex-only")));
    }, { selectedClaude: true });
  });
}

for (const managedClaude of [false, true]) {
  test(`Codex setup rollback respects Claude ownership (managed=${managedClaude})`, async () => {
    await fixture(async ({ host, settings, journal }) => {
      const previousSettings = managedClaude ? fs.readFileSync(settings) : undefined;
      const previousJournal = managedClaude ? fs.readFileSync(journal) : undefined;
      host.run = async (_name, args) => {
        if (args.includes("--preflight-only")) return { code: 0, stdout: "" };
        if (managedClaude) {
          fs.writeFileSync(settings, "changed settings");
          fs.writeFileSync(journal, "changed journal");
        }
        throw new Error("fixture setup failed");
      };
      await assert.rejects(host.setupCore("codex"), /fixture setup failed/);
      if (managedClaude) {
        assert.deepEqual(fs.readFileSync(settings), previousSettings);
        assert.deepEqual(fs.readFileSync(journal), previousJournal);
      } else {
        assert.equal(fs.statSync(settings).isDirectory(), true);
        assert.equal(fs.existsSync(journal), false);
      }
    }, { managedClaude });
  });
}
