"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { randomBytes } = require("node:crypto");
const { isLegacyConnectorName, validateConnectorName } = require("./connector-identity.cjs");
const { assertBiggerContextChangeAllowed } = require("./context-mode.cjs");
const CORE_SETUP_TIMEOUT_MS = 5 * 60_000;
const MCP_SETUP_TIMEOUT_MS = 10 * 60_000;

async function runSetup(name, args, options) {
  if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
  if (this.launcherProfile === "production" && args[0] === "setup"
    && !args.some(arg => ["--codex-only", "--claude-only", "--all-integrations"].includes(arg))) {
    args = [...args, "--codex-only"];
  }
  const previousRuntime = this.runtimeConfigSnapshot();
  const checkpoint = this.captureSetupCheckpoint(previousRuntime,
    args.includes("--claude-only") || args.includes("--all-integrations"));
  this.lifecycleOperation = name;
  let setupCommandStarted = false;
  let runtimeTransitionStarted = false;
  try {
    if (this.launcherProfile === "production") {
      await this.run(name, [...args, "--preflight-only"], {
        ...options,
        message: "Validating Codex configuration before changing the runtime",
        successMessage: "Codex configuration is ready for setup",
        timeoutMs: options.timeoutMs || CORE_SETUP_TIMEOUT_MS,
      });
    }
    runtimeTransitionStarted = true;
    if (previousRuntime.owner === "external") this.supervisor.prepareExternalMigration();
    else await this.supervisor.stopForSetup(name === "browser-interaction-mode" ? { browserOnly: true } : undefined);
    setupCommandStarted = true;
    const result = await this.run(name, args, options);
    const runtime = await this.supervisor.startIfConfigured();
    if (runtime.status !== "ready") {
      throw new Error(`Setup completed, but the launcher-owned runtime is ${runtime.status}: ${runtime.detail || "not ready"}`);
    }
    await options.afterRuntimeReady?.();
    return result;
  } catch (error) {
    const primary = error instanceof Error ? error.message : String(error);
    const failures = [];
    let rolledBack = false;
    let checkpointChanged = false;
    if (!previousRuntime.configured && setupCommandStarted) {
      try {
        rolledBack = await this.rollbackFirstSetup(checkpoint);
      } catch (caught) {
        failures.push(
          `first-time setup rollback failed: ${caught instanceof Error ? caught.message : String(caught)}`,
        );
      }
    }
    if (runtimeTransitionStarted && previousRuntime.configured && checkpoint) {
      try {
        checkpointChanged = this.setupCheckpointChanged(checkpoint);
      } catch (caught) {
        checkpointChanged = true;
        failures.push(
          `checking the setup checkpoint failed: ${caught instanceof Error ? caught.message : String(caught)}`,
        );
      }
      try {
        this.restoreSetupCheckpoint(checkpoint);
      } catch (caught) {
        failures.push(caught instanceof Error ? caught.message : String(caught));
      }
    }
    let recoveryError;
    try {
      if (runtimeTransitionStarted) {
        await this.restorePreviousRuntime(previousRuntime, name, {
          repairExternal: previousRuntime.owner === "external" && checkpointChanged,
        });
      }
    } catch (caught) {
      recoveryError = caught;
    }
    if (recoveryError) {
      failures.push(
        `restoring the previous launcher runtime failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
      );
    }
    const message = [
      primary,
      ...(rolledBack ? ["incomplete first-time setup was rolled back"] : []),
      ...failures,
    ].join("; ");
    this.publishOperation?.({ name, status: "failed", message });
    throw new Error(message, { cause: error });
  } finally {
    this.lifecycleOperation = null;
  }
}

module.exports = {
  async setFreshConversationPerTurn(enabled) {
    if (typeof enabled !== "boolean") throw new Error("Fresh conversation preference must be a boolean");
    const current = this.runtimeConfigSnapshot();
    if (!current.configured) throw new Error("Initialize the runtime before changing browser conversation retention");
    if ((current.config?.browserInteractionMode ?? "automatic") !== "automatic") {
      throw new Error("New browser chats per turn are unavailable in Zero Risk mode");
    }
    if (enabled && current.config?.useEnhancedWebSessionMode === true) {
      throw new Error("New browser chats per turn are unavailable while Enhanced Web session mode is enabled");
    }
    const development = this.launcherProfile === "development";
    const args = [
      ...(development ? ["dev", "setup"] : ["setup"]),
      current.mode === "full" ? "--full" : "--browser-only",
      "--browser-host-descriptor", this.browserDescriptorPath,
      ...this.browserInteractionArgs(),
      "--acknowledge-unofficial",
      ...(development ? [] : ["--replace-codex-route", "--restart-service"]),
      enabled ? "--fresh-conversation" : "--retained-conversation",
    ];
    if (current.config?.autoApproveToolCalls === true) args.push("--auto-approve-tool-calls");
    const options = {
      message: enabled ? "Enabling a new browser chat for each turn" : "Restoring browser chat retention",
      successMessage: enabled ? "New browser chats per turn enabled" : "Browser chat retention restored",
      timeoutMs: CORE_SETUP_TIMEOUT_MS,
    };
    const result = development
      ? await this.runDevSetup("fresh-conversation-per-turn", args, options)
      : await this.runSetup("fresh-conversation-per-turn", args, options);
    return { ...result, enabled };
  },

  async setUseSavedChats(enabled) {
    if (typeof enabled !== "boolean") throw new Error("Saved chat preference must be a boolean");
    const current = this.runtimeConfigSnapshot();
    if (!current.configured) throw new Error("Initialize the runtime before changing saved chats");
    const development = this.launcherProfile === "development";
    const args = [
      ...(development ? ["dev", "setup"] : ["setup"]),
      current.mode === "full" ? "--full" : "--browser-only",
      "--browser-host-descriptor", this.browserDescriptorPath,
      ...this.browserInteractionArgs(),
      "--acknowledge-unofficial",
      ...(development ? [] : ["--replace-codex-route", "--restart-service"]),
      enabled ? "--saved-chats" : "--temporary-chats",
    ];
    if (current.config?.autoApproveToolCalls === true) args.push("--auto-approve-tool-calls");
    const options = {
      message: enabled ? "Enabling saved ChatGPT conversations" : "Restoring Temporary Chat",
      successMessage: enabled ? "Saved ChatGPT conversations enabled" : "Temporary Chat restored",
      timeoutMs: CORE_SETUP_TIMEOUT_MS,
    };
    const result = development
      ? await this.runDevSetup("use-saved-chats", args, options)
      : await this.runSetup("use-saved-chats", args, options);
    return { ...result, enabled };
  },

  runSetup,
  async setupCore(integration = "codex") {
    this.assertProductionProfile("Codex integration setup");
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    if (!new Set(["all", "codex", "claude"]).has(integration)) {
      throw new Error(`Unsupported setup integration: ${integration}`);
    }
    const existing = this.runtimeConfigSnapshot();
    const mode = existing.mode;
    const interactionMode = existing.configured
      ? existing.config?.browserInteractionMode ?? this.browserInteractionMode()
      : this.browserInteractionMode();
    if (!existing.configured && interactionMode === "manual") {
      throw new Error("Zero Risk must be installed through MCP setup because tunnel credentials are required");
    }
    const args = [
      "setup",
      mode === "full" ? "--full" : "--browser-only",
      "--browser-host-descriptor",
      this.browserDescriptorPath,
      ...this.browserInteractionArgs({ mode: interactionMode, refreshCapabilities: true }),
    ];
    if (integration === "codex") args.push("--codex-only");
    if (integration === "claude") args.push("--claude-only");
    if (integration === "all") args.push("--all-integrations");
    args.push("--replace-codex-route");
    args.push("--acknowledge-unofficial", "--restart-service");
    const target = integration === "all" ? "Codex and Claude Code" : integration === "claude" ? "Claude Code" : "Codex";
    const result = await this.runSetup("core-setup", args, {
      message: `Installing ChatGPT Web models into ${target}`,
      successMessage: `${target} integration installed`,
      timeoutMs: CORE_SETUP_TIMEOUT_MS,
    });
    return { ...result, mode };
  },

  async setupDevCore() {
    if (this.launcherProfile !== "development") {
      throw new Error("DEV profile setup requires the isolated DEV launcher");
    }
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const existing = this.runtimeConfigSnapshot();
    const mode = existing.mode;
    const interactionMode = existing.configured
      ? existing.config?.browserInteractionMode ?? this.browserInteractionMode()
      : "automatic";
    const args = [
      "dev",
      "setup",
      mode === "full" ? "--full" : "--browser-only",
      "--browser-host-descriptor",
      this.browserDescriptorPath,
      ...this.browserInteractionArgs({ mode: interactionMode, refreshCapabilities: true }),
      "--acknowledge-unofficial",
    ];
    const result = await this.runDevSetup("dev-profile-setup", args, {
      message: "Configuring the isolated DEV harness",
      successMessage: "Isolated DEV harness configured",
      timeoutMs: mode === "full" ? MCP_SETUP_TIMEOUT_MS : CORE_SETUP_TIMEOUT_MS,
    });
    return { ...result, mode };
  },

  async setBiggerContext(enabled) {
    const current = this.runtimeConfigSnapshot();
    if (!current.configured) {
      throw new Error("Initialize the runtime before changing Bigger Context");
    }
    assertBiggerContextChangeAllowed(current.config, enabled === true);
    const mode = current.mode;
    const contextFlag = enabled === true ? "--bigger-context" : "--standard-context";
    if (this.launcherProfile === "development") {
      const args = [
        "dev",
        "setup",
        mode === "full" ? "--full" : "--browser-only",
        "--browser-host-descriptor",
        this.browserDescriptorPath,
        ...this.browserInteractionArgs(),
        "--acknowledge-unofficial",
        contextFlag,
      ];
      if (current.config?.autoApproveToolCalls === true) args.push("--auto-approve-tool-calls");
      const result = await this.runDevSetup("bigger-context", args, {
        message: enabled ? "Enabling Bigger Context" : "Disabling Bigger Context",
        successMessage: enabled ? "Bigger Context enabled" : "Standard context restored",
        timeoutMs: CORE_SETUP_TIMEOUT_MS,
      });
      return { ...result, mode, enabled: enabled === true };
    }
    const args = [
      "setup",
      mode === "full" ? "--full" : "--browser-only",
      "--browser-host-descriptor",
      this.browserDescriptorPath,
      ...this.browserInteractionArgs(),
      "--replace-codex-route",
      "--acknowledge-unofficial",
      "--restart-service",
      contextFlag,
    ];
    if (current.config?.autoApproveToolCalls === true) args.push("--auto-approve-tool-calls");
    const result = await this.runSetup("bigger-context", args, {
      message: enabled ? "Enabling Bigger Context" : "Disabling Bigger Context",
      successMessage: enabled ? "Bigger Context enabled; restart Codex" : "Standard context restored; restart Codex",
      timeoutMs: CORE_SETUP_TIMEOUT_MS,
    });
    return { ...result, mode, enabled: enabled === true };
  },

  async setSkillAttachments(enabled) {
    const current = this.runtimeConfigSnapshot();
    if (!current.configured) throw new Error("Initialize the runtime before changing Skills as files");
    if (current.config?.browserInteractionMode === "manual") {
      throw new Error("Skills as files is unavailable in Zero Risk mode");
    }
    const development = this.launcherProfile === "development";
    const args = [
      ...(development ? ["dev", "setup"] : ["setup"]),
      current.mode === "full" ? "--full" : "--browser-only",
      "--browser-host-descriptor", this.browserDescriptorPath,
      ...this.browserInteractionArgs(),
      "--acknowledge-unofficial",
      ...(development ? [] : ["--replace-codex-route", "--restart-service"]),
      enabled === true ? "--skill-attachments" : "--inline-skills",
    ];
    if (current.config?.autoApproveToolCalls === true) args.push("--auto-approve-tool-calls");
    const run = development ? this.runDevSetup.bind(this) : this.runSetup.bind(this);
    const result = await run("skill-attachments", args, {
      message: enabled ? "Enabling Skills as files" : "Disabling Skills as files",
      successMessage: enabled ? "Skills as files enabled" : "Inline skills restored",
      timeoutMs: CORE_SETUP_TIMEOUT_MS,
    });
    return { ...result, mode: current.mode, enabled: enabled === true };
  },

  async setExperimentalNoAutoCompact(enabled) {
    const current = this.runtimeConfigSnapshot();
    if (!current.configured) {
      throw new Error("Initialize the runtime before changing automatic compaction");
    }
    const route = this.launcherProfile === "development"
      ? null
      : await this.bridgeStatus("no-auto-compact-route");
    const mode = current.mode;
    const compactFlag = enabled === true ? "--no-auto-compact" : "--auto-compact";
    const args = [
      ...(this.launcherProfile === "development" ? ["dev"] : []),
      "setup",
      mode === "full" ? "--full" : "--browser-only",
      "--browser-host-descriptor",
      this.browserDescriptorPath,
      ...this.browserInteractionArgs(),
      ...(this.launcherProfile === "development" ? [] : ["--replace-codex-route"]),
      "--acknowledge-unofficial",
      ...(this.launcherProfile === "development" ? [] : ["--restart-service"]),
      compactFlag,
    ];
    if (current.config?.autoApproveToolCalls === true) args.push("--auto-approve-tool-calls");
    const run = this.launcherProfile === "development"
      ? this.runDevSetup.bind(this)
      : this.runSetup.bind(this);
    const result = await run("no-auto-compact", args, {
      message: enabled ? "Disabling Codex automatic compaction" : "Restoring Codex automatic compaction",
      successMessage: enabled
        ? "Codex automatic compaction disabled; restart Codex"
        : "Codex automatic compaction restored; restart Codex",
      timeoutMs: CORE_SETUP_TIMEOUT_MS,
    });
    if (route && !route.active) await this.setBridgeEnabled(false);
    return { ...result, mode, enabled: enabled === true };
  },

  async upgradeManagedRuntime() {
    this.assertProductionProfile("Managed Codex runtime upgrade");
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const existing = this.runtimeConfigSnapshot();
    const currentVersion = this.app.getVersion();
    const connectorMigrationRequired = existing.mode === "full"
      && isLegacyConnectorName(validateConnectorName(existing.config?.appName));
    const interactionMode = existing.config?.browserInteractionMode ?? "automatic";
    const expectedTunnelProfile = interactionMode === "manual"
      ? "codex-chatgpt-web-zero-risk" : "codex-chatgpt-web";
    const expectedKeyFile = interactionMode === "manual"
      ? "tunnel-runtime-zero-risk.key" : "tunnel-runtime-automatic.key";
    const explicitTunnel = interactionMode === "manual"
      ? existing.config?.manualTunnel : existing.config?.automaticTunnel;
    const activeTunnel = existing.config?.tunnel;
    const tunnelProfileMigrationRequired = existing.mode === "full" && Boolean(activeTunnel) && Boolean(
      !explicitTunnel
      || explicitTunnel.tunnelId !== activeTunnel.tunnelId
      || activeTunnel.profileName !== expectedTunnelProfile
      || activeTunnel.alias !== expectedTunnelProfile
      || path.basename(activeTunnel.runtimeKeyFile) !== expectedKeyFile
    );
    if (existing.owner !== "launcher"
      || (existing.config?.releaseVersion === currentVersion && !connectorMigrationRequired && !tunnelProfileMigrationRequired)) {
      return { updated: false };
    }
    const route = await this.bridgeStatus("runtime-upgrade-route");
    const args = [
      "setup",
      existing.mode === "full" ? "--full" : "--browser-only",
      "--browser-host-descriptor",
      this.browserDescriptorPath,
      // A release may repair capability detection. Reusing the previous result can
      // keep eligible models disabled even after the corrected probe is installed.
      ...this.browserInteractionArgs({ mode: interactionMode, refreshCapabilities: true }),
      "--acknowledge-unofficial",
      "--restart-service",
    ];
    const result = await this.runSetup("runtime-upgrade", args, {
      message: tunnelProfileMigrationRequired
        ? `Separating ${interactionMode === "manual" ? "Zero Risk" : "Automatic"} MCP credentials`
        : `Upgrading launcher runtime from ${existing.config.releaseVersion} to ${currentVersion}`,
      successMessage: tunnelProfileMigrationRequired
        ? `${interactionMode === "manual" ? "Zero Risk" : "Automatic"} MCP profile migrated`
        : `Launcher runtime upgraded to ${currentVersion}`,
      timeoutMs: existing.mode === "full" ? MCP_SETUP_TIMEOUT_MS : CORE_SETUP_TIMEOUT_MS,
    });
    if (!route.active) await this.setBridgeEnabled(false);
    return {
      updated: true,
      mode: existing.mode,
      bridgeEnabled: route.active,
      fromVersion: existing.config.releaseVersion,
      toVersion: currentVersion,
      connectorMigrated: connectorMigrationRequired,
      stdout: result.stdout,
    };
  },

  setupMcp({ tunnelId = "", runtimeKey = "", replace = false, interactionMode } = {}, afterRuntimeReady) {
    this.assertProductionProfile("Native Codex MCP setup");
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const targetMode = interactionMode ?? this.browserInteractionMode();
    const reuseSavedCredentials = replace !== true && this.mcpCredentialsConfigured(targetMode);
    if (!reuseSavedCredentials && !/^tunnel_[a-f0-9]{32}$/.test(tunnelId)) {
      throw new Error("Tunnel ID must be tunnel_ followed by 32 lowercase hexadecimal characters");
    }
    if (!reuseSavedCredentials && (typeof runtimeKey !== "string" || runtimeKey.trim().length < 20)) {
      throw new Error("A Tunnels Read + Use runtime key is required");
    }
    const args = [
      "setup",
      "--full",
      "--browser-host-descriptor",
      this.browserDescriptorPath,
      ...this.browserInteractionArgs({ mode: targetMode }),
      "--replace-codex-route",
    ];
    if (reuseSavedCredentials) {
      args.push("--acknowledge-unofficial", "--restart-service");
      return this.runSetup("mcp-setup", args, {
        message: "Reconnecting the native Codex harness with saved tunnel credentials",
        successMessage: "Local MCP tools are ready",
        timeoutMs: MCP_SETUP_TIMEOUT_MS,
        afterRuntimeReady,
      });
    }
    const secretsDir = path.join(this.app.getPath("userData"), "secrets");
    fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(secretsDir, 0o700); } catch {}
    const keyPath = path.join(secretsDir, `runtime-key-${randomBytes(16).toString("hex")}.tmp`);
    fs.writeFileSync(keyPath, runtimeKey.trim(), { flag: "wx", mode: 0o600 });
    args.push(
      "--tunnel-id",
      tunnelId,
      "--runtime-key-file",
      keyPath,
      "--acknowledge-unofficial",
      "--restart-service",
    );
    return this.runSetup("mcp-setup", args, {
      message: "Connecting the native Codex harness",
      successMessage: "Local MCP tools are ready",
      timeoutMs: MCP_SETUP_TIMEOUT_MS,
      afterRuntimeReady,
    }).finally(() => fs.rmSync(keyPath, { force: true }));
  },

  setupDevMcp({ tunnelId = "", runtimeKey = "", replace = false, interactionMode } = {}, afterRuntimeReady) {
    if (this.launcherProfile !== "development") {
      throw new Error("DEV MCP setup requires the isolated DEV launcher");
    }
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const targetMode = interactionMode ?? this.browserInteractionMode();
    const reuseSavedCredentials = replace !== true && this.mcpCredentialsConfigured(targetMode);
    if (!reuseSavedCredentials && !/^tunnel_[a-f0-9]{32}$/.test(tunnelId)) {
      throw new Error("Tunnel ID must be tunnel_ followed by 32 lowercase hexadecimal characters");
    }
    if (!reuseSavedCredentials && (typeof runtimeKey !== "string" || runtimeKey.trim().length < 20)) {
      throw new Error("A Tunnels Read + Use runtime key is required");
    }
    const args = [
      "dev",
      "setup",
      "--full",
      "--browser-host-descriptor",
      this.browserDescriptorPath,
      ...this.browserInteractionArgs({ mode: targetMode }),
      "--acknowledge-unofficial",
    ];
    if (reuseSavedCredentials) {
      return this.runDevSetup("dev-mcp-setup", args, {
        message: "Validating saved DEV tunnel credentials",
        successMessage: "DEV Full harness is configured",
        timeoutMs: MCP_SETUP_TIMEOUT_MS,
        afterRuntimeReady,
      });
    }
    const secretsDir = path.join(this.app.getPath("userData"), "secrets");
    fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(secretsDir, 0o700); } catch {}
    const keyPath = path.join(secretsDir, `runtime-key-${randomBytes(16).toString("hex")}.tmp`);
    fs.writeFileSync(keyPath, runtimeKey.trim(), { flag: "wx", mode: 0o600 });
    args.push("--tunnel-id", tunnelId, "--runtime-key-file", keyPath);
    return this.runDevSetup("dev-mcp-setup", args, {
      message: "Configuring the isolated DEV Full harness",
      successMessage: "DEV Full harness is configured",
      timeoutMs: MCP_SETUP_TIMEOUT_MS,
      afterRuntimeReady,
    }).finally(() => fs.rmSync(keyPath, { force: true }));
  },

  async setZeroRiskPro(enabled) {
    const current = this.runtimeConfigSnapshot();
    if (!current.configured) throw new Error("Install the Codex integration before changing Zero Risk model profiles");
    if (current.mode !== "full" || current.config?.browserInteractionMode !== "manual") {
      throw new Error("Zero Risk Pro is available only while the Full Zero Risk harness is active");
    }
    const args = [
      ...(this.launcherProfile === "development" ? ["dev", "setup"] : ["setup"]),
      "--full", "--browser-host-descriptor", this.browserDescriptorPath,
      ...this.browserInteractionArgs({ mode: "manual" }),
      "--acknowledge-unofficial", "--standard-context",
      enabled ? "--zero-risk-pro" : "--zero-risk-default",
      ...(this.launcherProfile === "production" ? ["--replace-codex-route", "--restart-service"] : []),
    ];
    if (current.config?.autoApproveToolCalls === true) args.push("--auto-approve-tool-calls");
    const options = {
      message: enabled ? "Installing the Zero Risk Pro model" : "Removing the Zero Risk Pro model",
      successMessage: enabled ? "Zero Risk Pro installed; restart Codex" : "Default Zero Risk model restored; restart Codex",
      timeoutMs: CORE_SETUP_TIMEOUT_MS,
    };
    const result = this.launcherProfile === "development"
      ? await this.runDevSetup("zero-risk-pro", args, options)
      : await this.runSetup("zero-risk-pro", args, options);
    return { ...result, mode: current.mode, enabled: enabled === true };
  },

  async setBrowserInteractionMode(mode, afterRuntimeReady) {
    if (mode !== "automatic" && mode !== "manual") throw new Error("Browser interaction mode is invalid");
    const current = this.runtimeConfigSnapshot();
    if (!current.configured) throw new Error("Install the Codex integration before changing browser interaction mode");
    if (mode === "manual" && current.mode !== "full") throw new Error("Connect the Full MCP harness before enabling Zero Risk");
    const args = [
      ...(this.launcherProfile === "development" ? ["dev", "setup"] : ["setup"]),
      current.mode === "full" ? "--full" : "--browser-only",
      "--browser-host-descriptor", this.browserDescriptorPath,
      ...this.browserInteractionArgs({ mode, refreshCapabilities: true }),
      "--acknowledge-unofficial",
      ...(this.launcherProfile === "production" ? ["--replace-codex-route", "--restart-service"] : []),
      mode === "automatic" && current.config?.experimentalBiggerContext === true
        ? "--bigger-context" : "--standard-context",
    ];
    if (current.config?.autoApproveToolCalls === true) args.push("--auto-approve-tool-calls");
    const options = {
      message: mode === "manual" ? "Enabling Zero Risk" : "Enabling automatic browser interaction",
      successMessage: `${mode === "manual" ? "Zero Risk" : "Automatic browser interaction"} enabled; restart Codex`,
      timeoutMs: current.mode === "full" ? MCP_SETUP_TIMEOUT_MS : CORE_SETUP_TIMEOUT_MS,
      afterRuntimeReady,
    };
    const result = this.launcherProfile === "development"
      ? await this.runDevSetup("browser-interaction-mode", args, options)
      : await this.runSetup("browser-interaction-mode", args, options);
    return { configured: true, mode, stdout: result.stdout };
  },

  async runDevSetup(name, args, options) {
    if (this.launcherProfile !== "development") {
      throw new Error("DEV setup transaction requires the isolated DEV launcher");
    }
    return this.runSetup(name, args, {
      ...options,
      embedded: true,
      environment: this.devSetupEnvironment(),
    });
  },
};
