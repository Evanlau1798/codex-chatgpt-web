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
  const fixture = hostFor({ mode: "full", appName: "Codex Native2" });
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
    proAvailable: false,
  });
  fixture.host.bridgeStatus = async () => ({ installed: true, active: true, errors: [] });

  const result = await fixture.host.upgradeManagedRuntime();

  assert.deepEqual(fixture.invocation().args, [
    "setup",
    "--full",
    "--browser-host-descriptor",
    "/runtime/launcher-browser.json",
    "--automatic-browser-interaction",
    "--refresh-account-capabilities",
    "--acknowledge-unofficial",
    "--restart-service",
  ]);
  assert.deepEqual(result, {
    updated: true,
    mode: "full",
    bridgeEnabled: true,
    fromVersion: "1.1.1",
    toVersion: "1.1.3",
    connectorMigrated: false,
    stdout: "",
  });
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
    "--refresh-account-capabilities",
    "--acknowledge-unofficial",
    "--restart-service",
  ]);
  assert.equal(result.updated, true);
  assert.equal(result.connectorMigrated, true);
  assert.equal(result.fromVersion, result.toVersion);
});

test("launcher update transaction preserves a deliberately disconnected Codex route", async () => {
  const fixture = hostFor({
    mode: "browser-only",
    browserHost: "launcher",
    releaseVersion: "1.1.1",
  });
  let disabled = 0;
  fixture.host.bridgeStatus = async () => ({ installed: true, active: false, errors: [] });
  fixture.host.setBridgeEnabled = async (enabled) => {
    assert.equal(enabled, false);
    disabled += 1;
  };

  const result = await fixture.host.upgradeManagedRuntime();

  assert.equal(result.bridgeEnabled, false);
  assert.equal(disabled, 1);
  assert.equal(fixture.invocation().args.includes("--refresh-account-capabilities"), true);
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
