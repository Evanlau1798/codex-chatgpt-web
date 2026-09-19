const path = require("node:path");
const setupOperations = require("./runtime-setup.cjs");
const checkpointOperations = require("./runtime-setup-checkpoint.cjs");
const integrationOperations = require("./runtime-integration.cjs");
const loginOperations = require("./runtime-login.cjs");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { readJsonFile } = require("./json-file.cjs");
const { CURRENT_CONNECTOR_NAME } = require("./connector-identity.cjs");
const { embeddedRuntimeInvocation, runtimeInvocation } = require("./runtime-command.cjs");
const { redactText } = require("./logging.cjs");
const { DETACH_OWNED_CHILD, terminateOwnedProcessTree } = require("./process-tree.cjs");
const { inspectClaudeIntegrationStatus } = require("./claude-integration-status.cjs");

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_RUNTIME_LOG_LINE_CHARS = 64 * 1024;
function collect(stream, chunks, onLine, onError) {
  let buffered = "";
  let bytes = 0;
  stream.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes <= MAX_CAPTURE_BYTES) chunks.push(chunk);
    buffered += chunk.toString("utf8");
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trimEnd();
      buffered = buffered.slice(newline + 1);
      if (line) onLine(line);
    }
    if (buffered.length > MAX_RUNTIME_LOG_LINE_CHARS) {
      onLine(`${buffered.slice(0, MAX_RUNTIME_LOG_LINE_CHARS)}…[truncated]`);
      buffered = "";
    }
  });
  stream.on("end", () => {
    const line = buffered.trim();
    if (line) onLine(line);
  });
  stream.on("error", (error) => onError?.(error));
}

function resolveUserPath(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

class RuntimeHost {
  constructor({
    app,
    logger,
    sourceRoot,
    installedRuntimeRoot,
    runtimeRootProvider,
    browserHostProvider,
    browserDescriptorPath,
    coreHome,
    codexHome,
    launcherProfile = "production",
    launchAgentsDir,
    platform = process.platform,
    publishOperation,
    supervisor,
    getBrowserInteractionMode = () => "automatic",
  }) {
    this.app = app;
    this.logger = logger;
    this.sourceRoot = sourceRoot;
    this.installedRuntimeRoot = installedRuntimeRoot;
    this.runtimeRootProvider = runtimeRootProvider;
    this.browserHostProvider = browserHostProvider;
    this.browserDescriptorPath = browserDescriptorPath;
    if (launcherProfile !== "production" && launcherProfile !== "development") {
      throw new Error("Runtime host launcher profile is invalid");
    }
    this.launcherProfile = launcherProfile;
    this.coreHome = coreHome ? resolveUserPath(coreHome) : null;
    if (launcherProfile === "development" && !this.coreHome) {
      throw new Error("Runtime host DEV profile requires its isolated home");
    }
    this.platform = platform;
    this.codexHome = codexHome
      ? resolveUserPath(codexHome)
      : process.env.CODEX_HOME?.trim()
        ? resolveUserPath(process.env.CODEX_HOME.trim())
        : path.join(os.homedir(), ".codex");
    this.claudeHome = process.env.CLAUDE_CONFIG_DIR?.trim()
      ? resolveUserPath(process.env.CLAUDE_CONFIG_DIR.trim())
      : path.join(this.app.getPath("home"), ".claude");
    this.launchAgentsDir = launchAgentsDir
      ? resolveUserPath(launchAgentsDir)
      : path.join(os.homedir(), "Library", "LaunchAgents");
    this.publishOperation = publishOperation;
    this.supervisor = supervisor;
    this.getBrowserInteractionMode = getBrowserInteractionMode;
    this.active = null;
    this.activeChild = null;
    this.lifecycleOperation = null;
    this.cleanupEphemeralSecrets();
    this.passkeyContinuationRequested = false;
    try {
      this.cleanupPasskeyTransfers();
    } catch (error) {
      this.logger.warn("runtime.passkey_cleanup_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  currentOperation() {
    const stuckChild = this.activeChild
      && this.activeChild.exitCode === null
      && this.activeChild.signalCode === null;
    return this.lifecycleOperation || this.active || (stuckChild ? "previous runtime process shutdown" : null);
  }

  async serializeRuntimeLifecycle(operation) {
    const previous = this.runtimeLifecycleOperation ?? Promise.resolve();
    let release;
    this.runtimeLifecycleOperation = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }

  browserInteractionMode() {
    const mode = this.getBrowserInteractionMode();
    if (mode !== "automatic" && mode !== "manual") throw new Error("Launcher browser interaction mode is invalid");
    return mode;
  }

  browserInteractionArgs({ refreshCapabilities = false, mode = this.browserInteractionMode() } = {}) {
    return [
      mode === "manual" ? "--zero-risk-browser-interaction" : "--automatic-browser-interaction",
      ...(mode === "automatic" && refreshCapabilities ? ["--refresh-account-capabilities"] : []),
    ];
  }

  assertProductionProfile(operation) {
    if (this.launcherProfile !== "production") {
      throw new Error(`${operation} is unavailable in the isolated DEV launcher profile`);
    }
  }

  cleanupEphemeralSecrets(...args) { return loginOperations.cleanupEphemeralSecrets.apply(this, args); }

  cleanupPasskeyTransfers(...args) { return loginOperations.cleanupPasskeyTransfers.apply(this, args); }

  passkeyChromeExecutable(...args) { return loginOperations.passkeyChromeExecutable.apply(this, args); }

  continuePasskeyLogin(...args) { return loginOperations.continuePasskeyLogin.apply(this, args); }

  capturePasskeyLogin(...args) { return loginOperations.capturePasskeyLogin.apply(this, args); }

  command(args) {
    if (this.runtimeRootProvider) this.installedRuntimeRoot = this.runtimeRootProvider();
    return runtimeInvocation({
      app: this.app,
      sourceRoot: this.sourceRoot,
      installedRuntimeRoot: this.installedRuntimeRoot,
      args,
    });
  }

  launcherControlEnvironment() {
    let descriptor;
    try {
      descriptor = readJsonFile(this.browserDescriptorPath);
    } catch (error) {
      throw new Error(
        `Launcher browser ownership descriptor is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const token = descriptor?.control?.token;
    if (descriptor?.pid !== process.pid || typeof token !== "string" || !/^[A-Za-z0-9_-]{40,}$/.test(token)) {
      throw new Error("Launcher browser ownership descriptor does not belong to this launcher process");
    }
    return { CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: token };
  }

  devSetupEnvironment(environment = process.env) {
    if (this.launcherProfile !== "development" || !this.coreHome) {
      throw new Error("DEV setup environment requires the isolated DEV launcher");
    }
    const childEnvironment = { ...environment };
    delete childEnvironment.CODEX_CHATGPT_WEB_HOME;
    delete childEnvironment.CODEX_HOME;
    delete childEnvironment.CODEX_WEB_GPT_LAUNCHER_DATA_DIR;
    childEnvironment.CODEX_WEB_GPT_DEV_HOME = this.coreHome;
    return childEnvironment;
  }

  runtimeConfigSnapshot() {
    const setupConfig = this.supervisor.readSetupConfig
      ? this.supervisor.readSetupConfig()
      : this.supervisor.readConfig();
    if (!setupConfig) {
      return {
        configured: false,
        owner: "none",
        mode: "browser-only",
        serialized: null,
      };
    }
    const launcherOwned = setupConfig.browserHost === "launcher";
    const config = launcherOwned ? this.supervisor.readConfig() : setupConfig;
    return {
      configured: true,
      owner: launcherOwned ? "launcher" : "external",
      mode: config.mode === "full" ? "full" : "browser-only",
      serialized: JSON.stringify(config),
      config: structuredClone(config),
    };
  }

  mcpCredentialsConfigured(mode = this.browserInteractionMode()) {
    const config = this.runtimeConfigSnapshot().config;
    const explicit = mode === "manual" ? config?.manualTunnel : config?.automaticTunnel;
    const hasProfiles = Boolean(config?.manualTunnel || config?.automaticTunnel);
    const tunnel = config?.mode === "full"
      ? explicit ?? (!hasProfiles && mode === "automatic" ? config.tunnel : null)
      : null;
    return Boolean(
      tunnel
      && /^tunnel_[a-f0-9]{32}$/.test(tunnel.tunnelId)
      && typeof tunnel.runtimeKeyFile === "string"
      && path.isAbsolute(tunnel.runtimeKeyFile)
      && fs.existsSync(tunnel.runtimeKeyFile),
    );
  }

  claudeIntegrationStatus() {
    const coreHome = this.supervisor.coreHome
      || (typeof this.supervisor.configPath === "string"
        ? path.dirname(this.supervisor.configPath)
        : path.join(os.homedir(), ".codex-chatgpt-web"));
    return inspectClaudeIntegrationStatus({
      journalPath: path.join(coreHome, "claude", "integration-journal.json"),
      settingsPath: path.join(this.claudeHome, "settings.json"),
    });
  }

  captureSetupCheckpoint(...args) { return checkpointOperations.captureSetupCheckpoint.apply(this, args); }

  setupCheckpointChanged(...args) { return checkpointOperations.setupCheckpointChanged.apply(this, args); }

  restoreSetupCheckpoint(...args) { return checkpointOperations.restoreSetupCheckpoint.apply(this, args); }

  restorePreviousRuntime(...args) { return checkpointOperations.restorePreviousRuntime.apply(this, args); }

  rollbackFirstSetup(...args) { return checkpointOperations.rollbackFirstSetup.apply(this, args); }

  async run(name, args, options = {}) {
    if (this.active) throw new Error(`Another launcher operation is active: ${this.active}`);
    if (this.activeChild
      && this.activeChild.exitCode === null
      && this.activeChild.signalCode === null) {
      throw new Error("A previous launcher operation process is still running");
    }
    this.activeChild = null;
    if (this.lifecycleOperation && this.lifecycleOperation !== name) {
      throw new Error(`Another launcher operation is active: ${this.lifecycleOperation}`);
    }
    this.active = name;
    this.publishOperation?.({ name, status: "running", message: options.message || name });
    this.logger.info("runtime.operation_started", { name, args: args.map((arg) => /key|token/i.test(arg) ? "[redacted]" : arg) });
    try {
      const invocation = options.embedded
        ? embeddedRuntimeInvocation({ app: this.app, sourceRoot: this.sourceRoot, args })
        : this.command(args);
      const result = await new Promise((resolve, reject) => {
        const environment = options.environment
          ? { ...options.environment }
          : { ...process.env };
        Object.assign(environment, {
          CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: this.browserDescriptorPath,
          ...(options.env || {}),
        });
        const child = spawn(invocation.executable, invocation.args, {
          cwd: invocation.cwd,
          detached: DETACH_OWNED_CHILD,
          env: environment,
          stdio: [options.controlStdin ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        this.activeChild = child;
        const stdout = [];
        const stderr = [];
        const pipeErrors = [];
        const recordPipeError = (stream) => (error) => {
          pipeErrors.push(`${name} ${stream} pipe failed: ${error instanceof Error ? error.message : String(error)}`);
        };
        collect(child.stdout, stdout, (line) => {
          this.logger.info("runtime.stdout", { operation: name, line });
          this.publishOperation?.({ name, status: "running", message: redactText(line) });
        }, recordPipeError("stdout"));
        collect(child.stderr, stderr, (line) => {
          this.logger.warn("runtime.stderr", { operation: name, line });
          this.publishOperation?.({ name, status: "running", message: redactText(line) });
        }, recordPipeError("stderr"));
        let settled = false;
        let timedOut = null;
        let terminationTimeout = null;
        let forceTimeout = null;
        const clearTimers = () => {
          if (timeout) clearTimeout(timeout);
          if (terminationTimeout) clearTimeout(terminationTimeout);
          if (forceTimeout) clearTimeout(forceTimeout);
        };
        const timeout = options.timeoutMs
          ? setTimeout(() => {
              if (settled) return;
              timedOut = new Error(`${name} timed out after ${options.timeoutMs}ms`);
              try {
                terminateOwnedProcessTree(child);
              } catch (error) {
                settled = true;
                clearTimers();
                reject(new Error(
                  `${timedOut.message}; child process tree termination failed: ${error instanceof Error ? error.message : String(error)}`,
                ));
                return;
              }
              terminationTimeout = setTimeout(() => {
                if (settled) return;
                try {
                  terminateOwnedProcessTree(child, "SIGKILL");
                } catch (error) {
                  settled = true;
                  clearTimers();
                  reject(new Error(
                    `${timedOut.message}; forced child process tree termination failed: ${error instanceof Error ? error.message : String(error)}`,
                  ));
                  return;
                }
                forceTimeout = setTimeout(() => {
                  if (settled) return;
                  settled = true;
                  clearTimers();
                  reject(new Error(`${timedOut.message}; the child process did not exit after forced termination`));
                }, 2_000);
              }, 5_000);
            }, options.timeoutMs)
          : null;
        child.once("error", (error) => {
          const childStillRunning = Number.isInteger(child.pid)
            && child.exitCode === null
            && child.signalCode === null;
          if (this.activeChild === child && !childStillRunning) this.activeChild = null;
          if (settled) return;
          settled = true;
          clearTimers();
          reject(timedOut
            ? new Error(`${timedOut.message}; termination failed: ${error.message}`)
            : error);
        });
        child.once("exit", (code, signal) => {
          if (this.activeChild === child) this.activeChild = null;
          if (settled) return;
          settled = true;
          clearTimers();
          if (timedOut) {
            try {
              terminateOwnedProcessTree(child, "SIGKILL");
              reject(timedOut);
            } catch (error) {
              reject(new Error(
                `${timedOut.message}; final process-group cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
              ));
            }
            return;
          }
          if (pipeErrors.length > 0) {
            reject(new Error(pipeErrors.join("; ")));
            return;
          }
          resolve({
            code: code ?? 1,
            signal,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        });
      });
      const acceptedExitCodes = options.acceptedExitCodes || [0];
      if (!acceptedExitCodes.includes(result.code)) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
        throw new Error(detail);
      }
      this.logger.info("runtime.operation_completed", { name });
      this.publishOperation?.({ name, status: "completed", message: options.successMessage || "Completed" });
      return result;
    } catch (error) {
      const message = redactText(error instanceof Error ? error.message : String(error));
      this.logger.error("runtime.operation_failed", { name, message });
      this.publishOperation?.({ name, status: "failed", message });
      throw new Error(message);
    } finally {
      this.active = null;
    }
  }

  doctor(...args) { return integrationOperations.doctor.apply(this, args); }

  devDoctor(...args) { return integrationOperations.devDoctor.apply(this, args); }

  bridgeStatus(...args) { return integrationOperations.bridgeStatus.apply(this, args); }

  restoreBridgeRouteWithinOperation(...args) { return integrationOperations.restoreBridgeRouteWithinOperation.apply(this, args); }

  restoreBridgeRoute(...args) { return integrationOperations.restoreBridgeRoute.apply(this, args); }

  setBridgeEnabled(...args) {
    return this.serializeRuntimeLifecycle(() => integrationOperations.setBridgeEnabled.apply(this, args));
  }

  setUseEnhancedWebSessionMode(...args) {
    return this.serializeRuntimeLifecycle(() => integrationOperations.setUseEnhancedWebSessionMode.apply(this, args));
  }

  setAccountSafetySettings(...args) {
    return this.serializeRuntimeLifecycle(() => integrationOperations.setAccountSafetySettings.apply(this, args));
  }

  accountSafetyStatus(...args) {
    return this.serializeRuntimeLifecycle(() => integrationOperations.accountSafetyStatus.apply(this, args));
  }

  resetAutomaticWebUsage(...args) {
    return this.serializeRuntimeLifecycle(() => integrationOperations.resetAutomaticWebUsage.apply(this, args));
  }

  resumeAutomaticWeb(...args) {
    return this.serializeRuntimeLifecycle(() => integrationOperations.resumeAutomaticWeb.apply(this, args));
  }

  acknowledgeAccountSafetyStop(...args) {
    return this.serializeRuntimeLifecycle(() => integrationOperations.acknowledgeAccountSafetyStop.apply(this, args));
  }

  setUseEnhancedOutputTunnel(...args) {
    return this.serializeRuntimeLifecycle(() => integrationOperations.setUseEnhancedOutputTunnel.apply(this, args));
  }

  mcpConnectorName(...args) { return integrationOperations.mcpConnectorName.apply(this, args); }

  browserConnectorName(...args) { return integrationOperations.browserConnectorName.apply(this, args); }

  setupConnectorName(...args) { return integrationOperations.setupConnectorName.apply(this, args); }

  cancelActiveTurns(...args) { return integrationOperations.cancelActiveTurns.apply(this, args); }

  uninstallIntegration(...args) {
    return this.serializeRuntimeLifecycle(() => integrationOperations.uninstallIntegration.apply(this, args));
  }

  setupCore(...args) { return setupOperations.setupCore.apply(this, args); }

  setupDevCore(...args) { return setupOperations.setupDevCore.apply(this, args); }

  setBiggerContext(...args) { return setupOperations.setBiggerContext.apply(this, args); }

  setSkillAttachments(...args) { return setupOperations.setSkillAttachments.apply(this, args); }

  setExperimentalNoAutoCompact(...args) { return setupOperations.setExperimentalNoAutoCompact.apply(this, args); }

  upgradeManagedRuntime(...args) { return setupOperations.upgradeManagedRuntime.apply(this, args); }

  setupMcp(...args) { return setupOperations.setupMcp.apply(this, args); }

  setupDevMcp(...args) { return setupOperations.setupDevMcp.apply(this, args); }

  setZeroRiskPro(...args) { return setupOperations.setZeroRiskPro.apply(this, args); }

  setBrowserInteractionMode(...args) { return setupOperations.setBrowserInteractionMode.apply(this, args); }

  runDevSetup(...args) { return setupOperations.runDevSetup.apply(this, args); }

  runSetup(...args) {
    return this.serializeRuntimeLifecycle(() => setupOperations.runSetup.apply(this, args));
  }
}

module.exports = { CURRENT_CONNECTOR_NAME, RuntimeHost };
