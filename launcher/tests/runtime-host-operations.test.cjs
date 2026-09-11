const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RuntimeHost } = require("../electron/runtime.cjs");
const { hostFor, devHostFor } = require("./support/runtime-host-fixture.cjs");
const { CURRENT_CONNECTOR_NAME, DEV_CONNECTOR_NAME } = require("../electron/connector-identity.cjs");

function bridgeFixture({ active }) {
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
      return { stdout: JSON.stringify({ installed: true, active: routeActive, errors: [] }) };
    }
    if (action === "route connect") {
      routeActive = true;
      return { stdout: JSON.stringify({ changed: true, active: true }) };
    }
    if (action === "route disconnect") {
      routeActive = false;
      return { stdout: JSON.stringify({ changed: true, active: false }) };
    }
    throw new Error(`Unexpected command: ${action}`);
  };
  return { calls, host, supervisor };
}

test("bridge connection starts a healthy runtime before routing Codex to it", async () => {
  const fixture = bridgeFixture({ active: false });
  const result = await fixture.host.setBridgeEnabled(true);
  assert.equal(result.active, true);
  assert.deepEqual(fixture.calls, ["route status", "runtime:start", "route connect", "route status"]);
});

test("bridge disconnection proves idleness and stops the runtime before restoring the prior route", async () => {
  const fixture = bridgeFixture({ active: true });
  const result = await fixture.host.setBridgeEnabled(false);
  assert.equal(result.active, false);
  assert.deepEqual(fixture.calls, ["route status", "runtime:stop", "route disconnect", "route status"]);
});

test("bridge connection rejects a route command that did not reach the requested state", async () => {
  const fixture = bridgeFixture({ active: false });
  fixture.host.run = async (_name, args) => {
    const action = args.join(" ");
    fixture.calls.push(action);
    if (action === "route status") {
      return { stdout: JSON.stringify({ installed: true, active: false, errors: [] }) };
    }
    return { stdout: JSON.stringify({ changed: false, active: false }) };
  };
  await assert.rejects(fixture.host.setBridgeEnabled(true), /remained disconnected/);
  assert.deepEqual(fixture.calls, ["route status", "runtime:start", "route connect", "runtime:stop"]);
});

test("bridge disconnection restarts the existing runtime if restoring the prior route fails", async () => {
  const fixture = bridgeFixture({ active: true });
  fixture.host.run = async (_name, args) => {
    const action = args.join(" ");
    fixture.calls.push(action);
    if (action === "route status") {
      return { stdout: JSON.stringify({ installed: true, active: true, errors: [] }) };
    }
    throw new Error("synthetic route restore failure");
  };
  await assert.rejects(fixture.host.setBridgeEnabled(false), /synthetic route restore failure/);
  assert.deepEqual(fixture.calls, ["route status", "runtime:stop", "route disconnect", "runtime:start"]);
});

test("bridge disconnection rejects a command that reports success without changing the active config", async () => {
  const fixture = bridgeFixture({ active: true });
  fixture.host.run = async (_name, args) => {
    const action = args.join(" ");
    fixture.calls.push(action);
    if (action === "route status") {
      return { stdout: JSON.stringify({ installed: true, active: true, errors: [] }) };
    }
    if (action === "route disconnect") {
      return { stdout: JSON.stringify({ changed: true, active: false }) };
    }
    throw new Error(`Unexpected command: ${action}`);
  };

  await assert.rejects(
    fixture.host.setBridgeEnabled(false),
    /route restore did not persist in the active config/,
  );
  assert.deepEqual(fixture.calls, [
    "route status",
    "runtime:stop",
    "route disconnect",
    "route status",
    "runtime:start",
  ]);
});

test("startup recovery can restore the Codex route without requiring a healthy local runtime", async () => {
  const fixture = bridgeFixture({ active: true });
  const result = await fixture.host.restoreBridgeRoute("runtime-start-fail-safe");
  assert.equal(result.active, false);
  assert.deepEqual(fixture.calls, ["route status", "route disconnect", "route status"]);
});

test("failed runtime cleanup during removal still restores the previous Codex route", async () => {
  const calls = [];
  const config = { mode: "full", browserHost: "launcher", releaseVersion: "1.1.2" };
  const host = new RuntimeHost({
    app: { getPath: () => path.join(os.tmpdir(), "codex-web-gpt-uninstall-fail-safe") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor: {
      readConfig: () => config,
      readSetupConfig: () => config,
      stopForSetup: async () => {
        calls.push("runtime:stop");
        throw new Error("Tunnel health probe timed out after 5000ms");
      },
    },
  });
  let routeActive = true;
  host.run = async (_name, args) => {
    const action = args.join(" ");
    calls.push(action);
    if (action === "route status") {
      return { stdout: JSON.stringify({ installed: true, active: routeActive, errors: [] }) };
    }
    if (action === "route disconnect") {
      routeActive = false;
      return { stdout: JSON.stringify({ changed: true, active: false }) };
    }
    throw new Error(`Unexpected command: ${action}`);
  };

  await assert.rejects(
    host.uninstallIntegration(),
    /previous Codex route was restored, but launcher runtime cleanup did not complete/,
  );
  assert.deepEqual(calls, ["runtime:stop", "route status", "route disconnect", "route status"]);
});

test("integration removal is accepted only after a new status process observes it absent", async () => {
  const calls = [];
  const config = { mode: "browser-only", browserHost: "launcher", releaseVersion: "2.1.8" };
  const host = new RuntimeHost({
    app: { getPath: () => path.join(os.tmpdir(), "codex-web-gpt-uninstall-success") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor: {
      readConfig: () => config,
      readSetupConfig: () => config,
      stopForSetup: async () => { calls.push("runtime:stop"); },
    },
  });
  host.launcherControlEnvironment = () => ({ CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: "test-token" });
  host.run = async (_name, args) => {
    const action = args.join(" ");
    calls.push(action);
    if (action === "uninstall --yes --launcher-control") {
      return { stdout: "uninstalled\n" };
    }
    if (action === "route status") {
      return { stdout: JSON.stringify({ installed: false, active: false, errors: [] }) };
    }
    throw new Error(`Unexpected command: ${action}`);
  };

  await host.uninstallIntegration();
  assert.deepEqual(calls, [
    "runtime:stop",
    "uninstall --yes --launcher-control",
    "route status",
  ]);
});

test("integration removal rejects a command that leaves an inactive journal behind", async () => {
  const calls = [];
  const config = { mode: "browser-only", browserHost: "launcher", releaseVersion: "2.1.8" };
  const host = new RuntimeHost({
    app: { getPath: () => path.join(os.tmpdir(), "codex-web-gpt-uninstall-stale") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor: {
      readConfig: () => config,
      readSetupConfig: () => config,
      stopForSetup: async () => { calls.push("runtime:stop"); },
    },
  });
  host.launcherControlEnvironment = () => ({ CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: "test-token" });
  host.run = async (_name, args) => {
    const action = args.join(" ");
    calls.push(action);
    if (action === "uninstall --yes --launcher-control") {
      return { stdout: "uninstalled\n" };
    }
    if (action === "route status") {
      return { stdout: JSON.stringify({ installed: true, active: false, errors: [] }) };
    }
    throw new Error(`Unexpected command: ${action}`);
  };

  await assert.rejects(
    host.uninstallIntegration(),
    /integration removal did not persist in the active config/,
  );
  assert.deepEqual(calls, [
    "runtime:stop",
    "uninstall --yes --launcher-control",
    "route status",
    "route status",
  ]);
});

test("connector verification uses the current identity and rejects a legacy local runtime", () => {
  const full = hostFor({ mode: "full", appName: "Codex Native2" });
  assert.equal(full.host.mcpConnectorName(), "Codex Native2");
  assert.equal(full.host.browserConnectorName(), "Codex Native2");
  const defaultName = hostFor(null);
  assert.equal(defaultName.host.browserConnectorName(), CURRENT_CONNECTOR_NAME);
  const legacyFull = hostFor({ mode: "full", appName: "Codex Native" });
  assert.equal(legacyFull.host.browserConnectorName(), "Codex Native2");
  assert.throws(
    () => legacyFull.host.mcpConnectorName(),
    /still targets legacy ChatGPT connector.*create that connector as a new ChatGPT plugin/,
  );
  const invalidFull = hostFor({ mode: "full", appName: "   " });
  assert.throws(() => invalidFull.host.mcpConnectorName(), /Connector name is invalid/);
  assert.throws(() => invalidFull.host.browserConnectorName(), /Connector name is invalid/);
  const browserOnly = hostFor({ mode: "browser-only", appName: "Codex Native" });
  assert.equal(browserOnly.host.browserConnectorName(), "Codex Native2");
  assert.throws(() => browserOnly.host.mcpConnectorName(), /MCP runtime is not configured/);
  const dev = devHostFor({ mode: "full", appName: "Codex Native2" });
  assert.equal(dev.host.browserConnectorName(), DEV_CONNECTOR_NAME);
  assert.equal(dev.host.mcpConnectorName(), DEV_CONNECTOR_NAME);
});

test("launcher-controlled CLI operations use the live descriptor token", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-control-"));
  const descriptorPath = path.join(root, "launcher-browser.json");
  fs.writeFileSync(descriptorPath, `${JSON.stringify({
    pid: process.pid,
    control: { token: "launcher-live-control-token-0123456789abcdefghijkl" },
  })}\n`);
  const host = new RuntimeHost({
    app: { getPath: () => root },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: descriptorPath,
    supervisor: { readConfig: () => null },
  });
  try {
    assert.deepEqual(host.launcherControlEnvironment(), {
      CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: "launcher-live-control-token-0123456789abcdefghijkl",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("macOS passkey capture uses an isolated launcher-controlled transfer", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-passkey-runtime-"));
  const chrome = path.join(root, "Google Chrome");
  fs.writeFileSync(chrome, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const host = new RuntimeHost({
    app: { getPath: () => root, isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: path.join(root, "launcher-browser.json"),
    platform: "darwin",
    supervisor: {
      readConfig: () => ({ chromeExecutablePath: chrome }),
      readSetupConfig: () => ({ chromeExecutablePath: chrome }),
    },
  });
  if (process.platform === "win32") {
    host.passkeyChromeExecutable = () => chrome;
  }
  host.launcherControlEnvironment = () => ({ CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: "token" });
  let invocation;
  host.run = async (name, args, options) => {
    invocation = { name, args, options };
    const statePath = args[args.indexOf("--storage-state") + 1];
    fs.writeFileSync(statePath, `${JSON.stringify({ cookies: [], origins: [] })}\n`, { mode: 0o600 });
    fs.writeFileSync(`${statePath}.verified.json`, `${JSON.stringify({
      version: 1,
      captureComplete: true,
      source: "isolated-normal-browser-profile",
      capturedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    const transfer = await host.capturePasskeyLogin();
    assert.deepEqual(transfer.storageState, { cookies: [], origins: [] });
    assert.equal(invocation.name, "passkey-login");
    assert.deepEqual(invocation.args.slice(0, 4), ["login", "--launcher-control", "--chrome", chrome]);
    assert.equal(invocation.options.embedded, true);
    assert.equal(invocation.options.controlStdin, true);
    assert.equal(invocation.options.timeoutMs, 10 * 60_000);
    const transferRoot = path.dirname(invocation.args[invocation.args.indexOf("--storage-state") + 1]);
    assert.equal(fs.existsSync(transferRoot), true);
    await transfer.cleanup();
    assert.equal(fs.existsSync(transferRoot), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("passkey Continue is delivered only to the active owned login child", async () => {
  const fixture = hostFor(null).host;
  let written = "";
  fixture.active = "passkey-login";
  fixture.activeChild = {
    exitCode: null,
    signalCode: null,
    stdin: {
      writable: true,
      write(value, callback) {
        written += value;
        callback();
      },
    },
  };
  assert.equal(await fixture.continuePasskeyLogin(), true);
  assert.deepEqual(JSON.parse(written), { version: 1, type: "passkey-login-continue" });
  assert.throws(() => fixture.continuePasskeyLogin(), /No passkey sign-in is waiting/);
});

test("passkey sign-in is rejected outside macOS even if IPC is invoked directly", () => {
  const fixture = hostFor(null).host;
  fixture.platform = "win32";
  assert.throws(() => fixture.passkeyChromeExecutable(), /supported only on macOS/);
});
