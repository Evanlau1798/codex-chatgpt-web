const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RuntimeHost } = require("../electron/runtime.cjs");
const { hostFor, devHostFor } = require("./support/runtime-host-fixture.cjs");

test("core setup preserves an existing full-harness installation", async () => {
  const fixture = hostFor({ mode: "full", appName: "Codex Native2" });
  const result = await fixture.host.setupCore();
  assert.equal(result.mode, "full");
  assert.deepEqual(fixture.invocation().args, [
    "setup",
    "--full",
      "--browser-host-descriptor",
      "/runtime/launcher-browser.json",
      "--automatic-browser-interaction",
      "--refresh-account-capabilities",
    "--codex-only",
    "--replace-codex-route",
    "--acknowledge-unofficial",
    "--restart-service",
  ]);
});

test("core setup replaces the known legacy connector identity with the direct-turn identity", async () => {
  const fixture = hostFor({ mode: "full", appName: "Codex Native" });
  await fixture.host.setupCore();
  assert.equal(fixture.invocation().args.includes("--app-name"), false);
  assert.equal(fixture.host.setupConnectorName(), "Codex Native2");
});

test("core setup starts in browser-only mode when no installation exists", async () => {
  const fixture = hostFor(null);
  const result = await fixture.host.setupCore();
  assert.equal(result.mode, "browser-only");
  assert.deepEqual(fixture.invocation().args.slice(0, 2), ["setup", "--browser-only"]);
  assert.equal(fixture.invocation().args.includes("--refresh-account-capabilities"), true);
  assert.equal(fixture.invocation().args.includes("--replace-codex-route"), true);
  assert.equal(fixture.invocation().args.includes("--chrome"), false);
});

test("launcher setup targets Codex and Claude Code independently", async () => {
  const codex = hostFor(null);
  await codex.host.setupCore("codex");
  assert.equal(codex.invocation().args.includes("--codex-only"), true);
  assert.equal(codex.invocation().args.includes("--claude-only"), false);
  assert.equal(codex.invocation().args.includes("--replace-codex-route"), true);

  const claude = hostFor(null);
  await claude.host.setupCore("claude");
  assert.equal(claude.invocation().args.includes("--claude-only"), true);
  assert.equal(claude.invocation().args.includes("--codex-only"), false);
  assert.equal(claude.invocation().args.includes("--replace-codex-route"), true);
});

test("DEV core setup configures only the isolated harness contract", async () => {
  const fixture = devHostFor(null);
  const result = await fixture.host.setupDevCore();
  assert.equal(result.mode, "browser-only");
  assert.deepEqual(fixture.invocation(), {
    name: "dev-profile-setup",
    args: [
      "dev",
      "setup",
      "--browser-only",
        "--browser-host-descriptor",
        "/dev/runtime/launcher-browser.json",
        "--automatic-browser-interaction",
        "--refresh-account-capabilities",
      "--acknowledge-unofficial",
    ],
  });
  assert.equal(fixture.invocation().args.includes("--replace-codex-route"), false);
  assert.equal(fixture.invocation().args.includes("--restart-service"), false);
});

test("Bigger Context uses the setup transaction and refreshes the production Codex catalog", async () => {
  const fixture = hostFor({ mode: "full", appName: "Codex Native2", solAvailable: true });
  const result = await fixture.host.setBiggerContext(true);
  assert.equal(result.enabled, true);
  assert.deepEqual(fixture.invocation(), {
    name: "bigger-context",
    args: [
      "setup",
      "--full",
        "--browser-host-descriptor",
        "/runtime/launcher-browser.json",
        "--automatic-browser-interaction",
        "--replace-codex-route",
      "--acknowledge-unofficial",
      "--restart-service",
      "--bigger-context",
    ],
  });
});

test("Luna can enable and disable Bigger Context in production and DEV", async () => {
  for (const createHost of [hostFor, devHostFor]) {
    const fixture = createHost({ mode: "browser-only", solAvailable: false, experimentalBiggerContext: true });
    assert.equal((await fixture.host.setBiggerContext(true)).enabled, true);
    assert.ok(fixture.invocation().args.includes("--bigger-context"));
    const result = await fixture.host.setBiggerContext(false);
    assert.equal(result.enabled, false);
    assert.ok(fixture.invocation().args.includes("--standard-context"));
  }
});

test("Bigger Context updates the isolated DEV config without installing a Codex route", async () => {
  const fixture = devHostFor({ mode: "browser-only" });
  const result = await fixture.host.setBiggerContext(false);
  assert.equal(result.enabled, false);
  assert.deepEqual(fixture.invocation(), {
    name: "bigger-context",
    args: [
      "dev",
      "setup",
      "--browser-only",
        "--browser-host-descriptor",
        "/dev/runtime/launcher-browser.json",
        "--automatic-browser-interaction",
        "--acknowledge-unofficial",
      "--standard-context",
    ],
  });
});

test("experimental no-auto-compact uses setup and requires a Codex restart", async () => {
  const fixture = hostFor({ mode: "full", appName: "Codex Native2" });
  fixture.host.bridgeStatus = async () => ({ installed: true, active: true, errors: [] });
  const result = await fixture.host.setExperimentalNoAutoCompact(true);
  assert.equal(result.enabled, true);
  assert.deepEqual(fixture.invocation(), {
    name: "no-auto-compact",
    args: [
      "setup",
      "--full",
      "--browser-host-descriptor",
      "/runtime/launcher-browser.json",
      "--automatic-browser-interaction",
      "--replace-codex-route",
      "--acknowledge-unofficial",
      "--restart-service",
      "--no-auto-compact",
    ],
  });
});

test("experimental no-auto-compact preserves a deliberately disconnected Codex route", async () => {
  const fixture = hostFor({ mode: "browser-only" });
  let disabled = 0;
  fixture.host.bridgeStatus = async () => ({ installed: true, active: false, errors: [] });
  fixture.host.setBridgeEnabled = async (enabled) => {
    assert.equal(enabled, false);
    disabled += 1;
  };

  await fixture.host.setExperimentalNoAutoCompact(true);

  assert.equal(disabled, 1);
});

test("DEV setup child environment removes launcher-rebound production aliases", async () => {
  const fixture = devHostFor(null);
  assert.deepEqual(fixture.host.devSetupEnvironment({
    KEEP_ME: "yes",
    CODEX_CHATGPT_WEB_HOME: "/dev",
    CODEX_HOME: "/dev/codex-home",
    CODEX_WEB_GPT_DEV_HOME: "/stale-dev",
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: "/dev/launcher",
  }), {
    KEEP_ME: "yes",
    CODEX_WEB_GPT_DEV_HOME: path.resolve("/dev"),
  });

  let runOptions;
  fixture.host.captureSetupCheckpoint = () => [];
  fixture.host.devSetupEnvironment = () => ({ ISOLATED_DEV_ENV: "yes" });
  fixture.host.run = async (_name, _args, options) => {
    runOptions = options;
    return { code: 0, stdout: "", stderr: "" };
  };

  await RuntimeHost.prototype.runDevSetup.call(fixture.host, "dev-environment-test", [], {});
  assert.equal(runOptions.embedded, true);
  assert.deepEqual(runOptions.environment, { ISOLATED_DEV_ENV: "yes" });
});

test("DEV MCP setup reuses only DEV-home credentials and targets its distinct connector", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-dev-mcp-host-"));
  const runtimeKeyFile = path.join(root, "runtime.key");
  fs.writeFileSync(runtimeKeyFile, "private key\n", { mode: 0o600 });
  const fixture = devHostFor({
    purpose: "dev-harness",
    mode: "full",
    browserHost: "launcher",
    appName: "Codex Native2",
    tunnel: {
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile,
    },
  });
  try {
    await fixture.host.setupDevMcp();
    assert.deepEqual(fixture.invocation(), {
      name: "dev-mcp-setup",
      args: [
        "dev",
        "setup",
        "--full",
        "--browser-host-descriptor",
        "/dev/runtime/launcher-browser.json",
        "--automatic-browser-interaction",
        "--acknowledge-unofficial",
      ],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("DEV doctor requires live tunnel readiness without probing a Responses listener", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-dev-doctor-"));
  const runtimeKeyFile = path.join(root, "runtime.key");
  fs.writeFileSync(runtimeKeyFile, "private key\n", { mode: 0o600 });
  const fixture = devHostFor({
    purpose: "dev-harness",
    mode: "full",
    appName: "Codex Native2 DEV",
    tunnel: { runtimeKeyFile },
  });
  fixture.host.supervisor.readTunnelHealth = async () => ({
    ready: true,
    detail: "ready",
  });
  try {
    const report = await fixture.host.devDoctor();
    assert.equal(report.ok, true);
    assert.deepEqual(report.checks.map(check => [check.id, check.status]), [
      ["dev-profile", "ok"],
      ["dev-tunnel-credentials", "ok"],
      ["dev-tunnel-runtime", "ok"],
      ["responses-listener", "ok"],
    ]);
    assert.match(report.checks.at(-1).message, /never starts a Responses listener/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("production doctor parses its structured unhealthy report from exit status one", async () => {
  const fixture = hostFor(null);
  let runOptions;
  fixture.host.run = async (_name, _args, options) => {
    runOptions = options;
    return {
      code: 1,
      stdout: JSON.stringify({
        ok: false,
        mode: "full",
        checks: [{ id: "browser-host", status: "error", message: "busy" }],
      }),
      stderr: "",
    };
  };

  const report = await fixture.host.doctor();

  assert.equal(report.ok, false);
  assert.equal(report.checks[0].message, "busy");
  assert.deepEqual(runOptions.acceptedExitCodes, [0, 1]);
});

test("production and DEV setup entrypoints reject the opposite launcher profile", async () => {
  await assert.rejects(hostFor(null).host.setupDevCore(), /isolated DEV launcher/);
  await assert.rejects(devHostFor(null).host.setupCore(), /unavailable in the isolated DEV launcher profile/);
});

test("launcher update transaction upgrades its owned full runtime with saved configuration", async () => {
  const fixture = hostFor({
    mode: "full",
    browserHost: "launcher",
    appName: "Codex Native2",
    releaseVersion: "1.1.1",
    solAvailable: true,
    extraHighAvailable: false, proAvailable: false,
  });
  fixture.host.bridgeStatus = async () => ({ installed: true, active: true, errors: [] });

  const result = await fixture.host.upgradeManagedRuntime();

  assert.deepEqual(fixture.invocation().args, [
    "setup",
    "--full",
    "--browser-host-descriptor",
    "/runtime/launcher-browser.json",
    "--automatic-browser-interaction",
    "--acknowledge-unofficial",
    "--restart-service",
    "--preserve-disconnected-route",
  ]);
  assert.deepEqual(result, {
    updated: true,
    mode: "full",
    fromVersion: "1.1.1",
    toVersion: "1.1.3",
    connectorMigrated: false,
    stdout: "",
  });
});

test("a failed version upgrade preserves setup inputs without starting an incompatible old runtime", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-upgrade-failure-"));
  const configPath = path.join(root, "config.json");
  const config = { mode: "browser-only", browserHost: "launcher", releaseVersion: "6.1.4" };
  fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  let stops = 0;
  let starts = 0;
  const host = new RuntimeHost({
    app: { getPath: () => root, getVersion: () => "6.1.6" },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: path.join(root, "launcher-browser.json"),
    codexHome: path.join(root, "codex"),
    supervisor: {
      configPath,
      readSetupConfig: () => JSON.parse(fs.readFileSync(configPath)),
      readConfig: () => JSON.parse(fs.readFileSync(configPath)),
      stopForSetup: async () => { stops += 1; },
      startIfConfigured: async () => { starts += 1; return { status: "needs-setup" }; },
    },
  });
  host.run = async (_name, args) => {
    assert.equal(args.includes("--refresh-account-capabilities"), false);
    if (args.includes("--preflight-only")) return { code: 0, stdout: "", stderr: "" };
    fs.writeFileSync(configPath, `${JSON.stringify({ ...config, releaseVersion: "6.1.6" })}\n`);
    throw new Error("configuration write failed");
  };
  try {
    await assert.rejects(host.upgradeManagedRuntime(), error => {
      assert.match(error.message, /configuration write failed/);
      assert.match(error.message, /Restart the launcher to retry the update/);
      assert.doesNotMatch(error.message, /Previous runtime recovery|expected ready/);
      return true;
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath)), config);
    assert.equal(stops, 1);
    assert.equal(starts, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher migrates the legacy connector identity even when the release version is unchanged", async () => {
  const fixture = hostFor({
    mode: "full",
    browserHost: "launcher",
    appName: "Codex Native",
    releaseVersion: "1.1.3",
  });
  fixture.host.bridgeStatus = async () => ({ installed: true, active: true, errors: [] });

  const result = await fixture.host.upgradeManagedRuntime();

  assert.deepEqual(fixture.invocation().args, [
    "setup",
    "--full",
    "--browser-host-descriptor",
    "/runtime/launcher-browser.json",
    "--automatic-browser-interaction",
    "--acknowledge-unofficial",
    "--restart-service",
    "--preserve-disconnected-route",
  ]);
  assert.equal(result.updated, true);
  assert.equal(result.connectorMigrated, true);
  assert.equal(result.fromVersion, result.toVersion);
});

test("launcher update delegates disconnected route preservation to the setup transaction", async () => {
  const fixture = hostFor({
    mode: "browser-only",
    browserHost: "launcher",
    releaseVersion: "1.1.1",
  });
  fixture.host.bridgeStatus = async () => { throw new Error("stale route preread"); };
  fixture.host.setBridgeEnabled = async () => { throw new Error("post-upgrade disconnect"); };

  const result = await fixture.host.upgradeManagedRuntime();

  assert.equal(result.updated, true);
  assert.equal(fixture.invocation().args.includes("--preserve-disconnected-route"), true);
  assert.equal(fixture.invocation().args.includes("--refresh-account-capabilities"), false);
});

test("launcher update preserves Zero Risk and never probes its account capabilities", async () => {
  const fixture = hostFor({
    mode: "full",
    browserHost: "launcher",
    browserInteractionMode: "manual",
    appName: "Codex Zero Risk",
    releaseVersion: "1.1.1",
  });
  fixture.host.bridgeStatus = async () => ({ installed: true, active: true, errors: [] });

  assert.equal((await fixture.host.upgradeManagedRuntime()).updated, true);
  assert.equal(fixture.invocation().args.includes("--zero-risk-browser-interaction"), true);
  assert.equal(fixture.invocation().args.includes("--automatic-browser-interaction"), false);
  assert.equal(fixture.invocation().args.includes("--refresh-account-capabilities"), false);
});

test("launcher update transaction leaves current and externally owned runtimes unchanged", async () => {
  const current = hostFor({ mode: "browser-only", browserHost: "launcher", releaseVersion: "1.1.3" });
  const currentFull = hostFor({
    mode: "full",
    browserHost: "launcher",
    appName: "Codex Native2",
    releaseVersion: "1.1.3",
  });
  const external = hostFor({ mode: "browser-only", browserHost: "managed-chrome", releaseVersion: "1.1.1" });

  assert.deepEqual(await current.host.upgradeManagedRuntime(), { updated: false });
  assert.deepEqual(await currentFull.host.upgradeManagedRuntime(), { updated: false });
  assert.deepEqual(await external.host.upgradeManagedRuntime(), { updated: false });
  assert.equal(current.invocation(), undefined);
  assert.equal(currentFull.invocation(), undefined);
  assert.equal(external.invocation(), undefined);
});

test("MCP setup reuses valid private credentials without exposing or rewriting them", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-saved-mcp-"));
  const keyPath = path.join(root, "tunnel-runtime.key");
  fs.writeFileSync(keyPath, "saved-private-runtime-key\n", { mode: 0o600 });
  const fixture = hostFor({
    mode: "full",
    appName: "Codex Native2",
    tunnel: {
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: keyPath,
    },
  });
  try {
    assert.equal(fixture.host.mcpCredentialsConfigured(), true);
    await fixture.host.setupMcp({ replace: false });
    assert.deepEqual(fixture.invocation().args, [
      "setup",
      "--full",
      "--browser-host-descriptor",
      "/runtime/launcher-browser.json",
      "--automatic-browser-interaction",
      "--replace-codex-route",
      "--acknowledge-unofficial",
      "--restart-service",
    ]);
    assert.equal(fixture.invocation().args.includes("--refresh-account-capabilities"), false);
    assert.equal(fixture.invocation().args.includes("--replace-codex-route"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("new MCP setup uses the fixed connector without a CLI name override", async () => {
  const fixture = hostFor(null);
  await fixture.host.setupMcp({
    replace: true,
    tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    runtimeKey: "new-private-runtime-key",
  });

  assert.deepEqual(fixture.invocation().args.slice(0, 5), [
    "setup",
    "--full",
    "--browser-host-descriptor",
    "/runtime/launcher-browser.json",
    "--automatic-browser-interaction",
  ]);
  assert.equal(fixture.invocation().args.includes("--app-name"), false);
  assert.equal(fixture.host.setupConnectorName(), "Codex Native2");
});

test("MCP credential replacement remains explicit and requires a complete new pair", async () => {
  const fixture = hostFor(null);
  await assert.rejects(
    Promise.resolve().then(() => fixture.host.setupMcp({ replace: true })),
    /Tunnel ID must be/,
  );
  await assert.rejects(
    Promise.resolve().then(() => fixture.host.setupMcp({
      replace: true,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    })),
    /runtime key is required/,
  );
});

test("mutating launcher operations are serialized before lifecycle changes begin", async () => {
  const fixture = hostFor(null);
  fixture.host.lifecycleOperation = "mcp-setup";
  await assert.rejects(fixture.host.setupCore(), /Another launcher operation is active: mcp-setup/);
  assert.equal(fixture.invocation(), undefined);
});

test("skill file experiment uses the setup transaction in production and DEV, and rejects manual mode", async () => {
  const production = hostFor({ mode: "full", browserInteractionMode: "automatic" });
  assert.equal((await production.host.setSkillAttachments(true)).enabled, true);
  assert.equal(production.invocation().args.includes("--skill-attachments"), true);
  assert.equal(production.invocation().args.includes("--restart-service"), true);
  const dev = devHostFor({ mode: "full", browserInteractionMode: "automatic" });
  assert.equal((await dev.host.setSkillAttachments(false)).enabled, false);
  assert.equal(dev.invocation().args.includes("--inline-skills"), true);
  assert.equal(dev.invocation().args.includes("--replace-codex-route"), false);
  const manual = hostFor({ mode: "full", browserInteractionMode: "manual" }, "manual");
  await assert.rejects(() => manual.host.setSkillAttachments(true), /Zero Risk/);
  assert.equal(manual.invocation(), undefined);
});


test("tool approvals opt in and out through setup without refreshing models or changing chat settings", async () => {
  for (const makeHost of [hostFor, devHostFor]) {
    for (const mode of ["browser-only", "full"]) {
      for (const enabled of [true, false]) {
        const fixture = makeHost({ mode, browserInteractionMode: "automatic", autoApproveToolCalls: !enabled });
        assert.equal((await fixture.host.setAutoApproveToolCalls(enabled)).enabled, enabled);
        const { name, args } = fixture.invocation();
        assert.equal(name, "auto-approve-tool-calls");
        assert.equal(args.includes("--auto-approve-tool-calls"), enabled);
        assert.equal(args.includes(`--${mode}`), true);
        assert.equal(args.includes("--restart-service"), makeHost === hostFor);
        assert.equal(args.includes("dev"), makeHost === devHostFor);
        for (const flag of ["--refresh-account-capabilities", "--login", "--fresh-conversation", "--retained-conversation", "--temporary-chats", "--saved-chats"]) {
          assert.equal(args.includes(flag), false);
        }
      }
    }
    for (const config of [null, { mode: "full", browserInteractionMode: "manual" }]) {
      const fixture = makeHost(config);
      await assert.rejects(() => fixture.host.setAutoApproveToolCalls(true), /Initialize|Zero Risk/);
      assert.equal(fixture.invocation(), undefined);
    }
    const fixture = makeHost({ mode: "full" });
    await assert.rejects(() => fixture.host.setAutoApproveToolCalls("true"), /boolean/);
    assert.equal(fixture.invocation(), undefined);
  }
});

test("fresh-conversation preference uses production and DEV setup without forcing mode or other preferences", async () => {
  for (const makeHost of [hostFor, devHostFor]) {
    for (const mode of ["browser-only", "full"]) {
      const existing = { mode, browserInteractionMode: "automatic", autoApproveToolCalls: true,
        experimentalFreshConversationPerTurn: false, experimentalSkillAttachments: true };
      const fixture = makeHost(existing);
      for (const enabled of [true, false]) {
        assert.equal((await fixture.host.setFreshConversationPerTurn(enabled)).enabled, enabled);
        const { name, args } = fixture.invocation();
        assert.equal(name, "fresh-conversation-per-turn");
        assert.deepEqual(args.slice(0, makeHost === devHostFor ? 2 : 1), makeHost === devHostFor ? ["dev", "setup"] : ["setup"]);
        assert.equal(args.includes(`--${mode}`), true);
        assert.equal(args.includes(enabled ? "--fresh-conversation" : "--retained-conversation"), true);
        assert.equal(args.includes(enabled ? "--retained-conversation" : "--fresh-conversation"), false);
        assert.equal(args.includes("--auto-approve-tool-calls"), true);
        assert.equal(args.includes("--restart-service"), makeHost === hostFor);
        assert.equal(args.includes("--replace-codex-route"), makeHost === hostFor);
        assert.equal(existing.experimentalFreshConversationPerTurn, false, "setter must delegate persistence to setup");
        assert.equal(existing.experimentalSkillAttachments, true);
      }
    }
    for (const config of [null, { mode: "full", browserInteractionMode: "manual" }]) {
      const fixture = makeHost(config);
      await assert.rejects(() => fixture.host.setFreshConversationPerTurn(true), /Initialize|Zero Risk/);
      await assert.rejects(() => fixture.host.setFreshConversationPerTurn(false), /Initialize|Zero Risk/);
      assert.equal(fixture.invocation(), undefined);
    }
    for (const interaction of ["automatic", "manual"]) {
      const saved = makeHost({ mode: "full", browserInteractionMode: interaction }, interaction);
      for (const enabled of [true, false]) {
        await saved.host.setUseSavedChats(enabled);
        assert.equal(saved.invocation().args.includes(enabled ? "--saved-chats" : "--temporary-chats"), true);
        assert.equal(saved.invocation().args.includes("--full"), true);
        assert.equal(saved.invocation().args.includes("--fresh-conversation"), false);
      }
      await assert.rejects(() => saved.host.setUseSavedChats("true"), /boolean/);
    }
    const fixture = makeHost({ mode: "browser-only", browserInteractionMode: "automatic" });
    await assert.rejects(() => fixture.host.setFreshConversationPerTurn("true"), /boolean/);
    assert.equal(fixture.invocation(), undefined);
  }
});


for (const development of [false, true]) test(`plugin renaming uses transactional ${development ? "DEV" : "production"} setup without changing credentials or refreshing models`, async () => {
  const factory = development ? devHostFor : hostFor;
  const fixture = factory({ mode: "full", appName: "Codex Work", automaticAppName: "Codex Work", manualAppName: "Codex Zero Risk" });
  assert.equal(fixture.host.setupConnectorName("manual"), "Codex Zero Risk");
  assert.equal(fixture.host.setupConnectorName("automatic"), "Codex Work");
  assert.equal(fixture.host.browserConnectorName(), "Codex Work");
  assert.equal(fixture.host.mcpConnectorName(), "Codex Work");
  assert.deepEqual(await fixture.host.setConnectorNameSuffix("Work"), { changed: false });
  assert.equal(fixture.invocation(), undefined);
  await fixture.host.setConnectorNameSuffix("Home");
  const args = fixture.invocation().args;
  assert.equal(args[args.indexOf("--connector-name-suffix") + 1], "Home");
  for (const unwanted of ["--refresh-account-capabilities", "--tunnel-id", "--runtime-key-file"]) assert.equal(args.includes(unwanted), false);
  await assert.rejects(fixture.host.setConnectorNameSuffix(""), /part after Codex/);
  await assert.rejects(fixture.host.setConnectorNameSuffix("Zero Risk"), /must differ/);
  await assert.rejects(fixture.host.setConnectorNameSuffix("Native"), /retired/);
  await assert.rejects(fixture.host.setConnectorNameSuffix("bad\nname"), /part after Codex/);
});

test("renaming rolls back the saved name if the new runtime fails", async () => {
  const config = { mode: "full", browserHost: "launcher", appName: "Codex Old", automaticAppName: "Codex Old" };
  const fixture = hostFor(config);
  const host = fixture.host;
  host.runSetup = RuntimeHost.prototype.runSetup;
  host.captureSetupCheckpoint = () => structuredClone(config);
  host.setupCheckpointChanged = () => true;
  host.restoreSetupCheckpoint = checkpoint => { Object.assign(config, checkpoint); };
  host.restorePreviousRuntime = async () => {};
  host.run = async (_name, args) => {
    if (!args.includes("--preflight-only")) Object.assign(config, { automaticAppName: "Codex New", appName: "Codex New" });
    return { stdout: "" };
  };
  host.supervisor.startIfConfigured = async () => ({ status: "failed", detail: "fixture failure" });
  await assert.rejects(host.setConnectorNameSuffix("New"), /fixture failure/);
  assert.equal(config.automaticAppName, "Codex Old");
  assert.equal(config.appName, "Codex Old");
});


function bridgeFixture({ active, recovery = false }) {
  const calls = [];
  let routeActive = active;
  const supervisor = {
    readConfig: () => ({ mode: "browser-only" }),
    readSetupConfig: () => ({ mode: "browser-only" }),
    startIfConfigured: async () => {
      calls.push("runtime:start");
      return { status: "ready" };
    },
    stopForSetup: async () => {
      calls.push("runtime:stop");
      return { status: "stopped" };
    },
  };
  const host = new RuntimeHost({
    app: { getPath: () => path.join(os.tmpdir(), "codex-web-gpt-bridge-test") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor,
  });
  host.run = async (_name, args) => {
    const action = args.join(" ");
    calls.push(action);
    if (action === "route status") {
      return { stdout: JSON.stringify({ installed: true, active: routeActive, reconnectOnStartup: recovery, errors: [] }) };
    }
    if (action === "route connect" || action === "route recover") {
      routeActive = true;
      recovery = false;
      return { stdout: JSON.stringify({ changed: true, active: true }) };
    }
    if (action === "route disconnect" || action === "route disconnect --for-runtime-recovery") {
      routeActive = false;
      recovery = action.endsWith("--for-runtime-recovery");
      return { stdout: JSON.stringify({ changed: true, active: false }) };
    }
    throw new Error(`Unexpected command: ${action}`);
  };
  return { calls, host, supervisor };
}

test("automatic startup reconnects only a route disconnected for runtime recovery", async () => {
  for (const recovery of [false, true]) {
    const fixture = bridgeFixture({ active: false, recovery });
    const result = await fixture.host.connectBridgeRoute({ recoveryOnly: true });
    assert.equal(result.active, recovery);
    assert.deepEqual(fixture.calls, recovery ? ["route status", "route recover", "route status"] : ["route status"]);
  }
});

test("explicit removal cancels pending recovery even when the route is already inactive", async () => {
  const fixture = bridgeFixture({ active: false, recovery: true });
  await fixture.host.restoreBridgeRoute("uninstall-integration");
  assert.deepEqual(fixture.calls, ["route status", "route disconnect", "route status"]);
  const result = await fixture.host.connectBridgeRoute({ recoveryOnly: true });
  assert.equal(result.active, false);
  assert.equal(fixture.calls.at(-1), "route status");
});
