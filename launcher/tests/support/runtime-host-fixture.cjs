const os = require("node:os");
const path = require("node:path");
const { RuntimeHost } = require("../../electron/runtime.cjs");

function hostFor(existingConfig) {
  const host = new RuntimeHost({
    app: {
      getPath: () => path.join(os.tmpdir(), "codex-web-gpt-runtime-host-test"),
      getVersion: () => "1.1.3",
    },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor: {
      readConfig: () => existingConfig,
      readSetupConfig: () => existingConfig,
      stopForSetup: async () => ({ status: "stopped" }),
      startIfConfigured: async () => ({ status: "ready" }),
    },
  });
  let invocation;
  host.runSetup = async (name, args, options = {}) => {
    invocation = { name, args };
    await options.afterRuntimeReady?.();
    return { code: 0, stdout: "", stderr: "" };
  };
  return { host, invocation: () => invocation };
}

function devHostFor(existingConfig) {
  const host = new RuntimeHost({
    app: {
      getPath: () => path.join(os.tmpdir(), "codex-web-gpt-dev-runtime-host-test"),
      getVersion: () => "1.1.3",
    },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/dev/runtime/launcher-browser.json",
    coreHome: "/dev",
    launcherProfile: "development",
    supervisor: {
      readConfig: () => existingConfig,
      readSetupConfig: () => existingConfig,
      stopForSetup: async () => ({ status: "stopped" }),
      startIfConfigured: async () => ({ status: "ready" }),
    },
  });
  let invocation;
  host.runDevSetup = async (name, args, options = {}) => {
    invocation = { name, args };
    await options.afterRuntimeReady?.();
    return { code: 0, stdout: "", stderr: "" };
  };
  return { host, invocation: () => invocation };
}

module.exports = { hostFor, devHostFor };
