"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { connectorNameForDevSetup, connectorNameForSetup, CURRENT_CONNECTOR_NAME, DEV_CONNECTOR_NAME, requireCurrentRuntimeConnectorName } = require("./connector-identity.cjs");
const { normalizeContextModes } = require("./context-mode.cjs");
const { setRuntimeBooleanSetting } = require("./runtime-boolean-setting.cjs");
const UNINSTALL_TIMEOUT_MS = 2 * 60_000;

function parseBridgeRouteResult(stdout, { expectedActive, requireInstalled = false } = {}) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error("Codex bridge route command returned invalid JSON");
  }
  if (typeof result?.active !== "boolean") {
    throw new Error("Codex bridge route command did not report its active state");
  }
  if (requireInstalled && typeof result.installed !== "boolean") {
    throw new Error("Codex bridge route status did not report whether the integration is installed");
  }
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    throw new Error(`Codex bridge route is inconsistent: ${result.errors.join("; ")}`);
  }
  if (typeof expectedActive === "boolean" && result.active !== expectedActive) {
    throw new Error(`Codex bridge route remained ${result.active ? "connected" : "disconnected"}`);
  }
  return result;
}

module.exports = {
  async doctor() {
    this.assertProductionProfile("Runtime doctor");
    try {
      const result = await this.run("doctor", ["doctor", "--json"], {
        message: "Checking runtime",
        timeoutMs: 75_000,
        acceptedExitCodes: [0, 1],
      });
      return JSON.parse(result.stdout);
    } catch (error) {
      return {
        ok: false,
        checks: [{ id: "runtime", status: "error", message: error instanceof Error ? error.message : String(error) }],
      };
    }
  },

  async devDoctor() {
    if (this.launcherProfile !== "development") {
      throw new Error("DEV harness diagnostics require the isolated DEV launcher profile");
    }
    const checks = [];
    let config;
    try {
      config = this.supervisor.readConfig();
      checks.push({
        id: "dev-profile",
        status: config?.purpose === "dev-harness" ? "ok" : "error",
        message: config?.purpose === "dev-harness"
          ? "Isolated DEV harness configuration is valid"
          : "Isolated DEV harness configuration is missing",
      });
    } catch (error) {
      checks.push({
        id: "dev-profile",
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const full = config?.mode === "full" && config?.tunnel;
    checks.push({
      id: "dev-tunnel-credentials",
      status: full && fs.existsSync(config.tunnel.runtimeKeyFile) ? "ok" : "error",
      message: full && fs.existsSync(config.tunnel.runtimeKeyFile)
        ? "DEV tunnel credentials are configured"
        : "DEV Full harness tunnel credentials are not configured",
    });
    if (full) {
      try {
        const runtime = await this.supervisor.readTunnelHealth(config);
        checks.push({
          id: "dev-tunnel-runtime",
          status: runtime.ready ? "ok" : "error",
          message: runtime.ready
            ? "Isolated DEV MCP tunnel runtime is ready"
            : "Isolated DEV MCP tunnel runtime is not ready",
          ...(!runtime.ready ? { detail: runtime.detail } : {}),
        });
      } catch (error) {
        checks.push({
          id: "dev-tunnel-runtime",
          status: "error",
          message: "Isolated DEV MCP tunnel runtime could not be inspected",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    checks.push({
      id: "responses-listener",
      status: "ok",
      message: "DEV runtime supervision is tunnel-only and never starts a Responses listener",
    });
    return {
      ok: checks.every(check => check.status !== "error"),
      mode: config?.mode,
      checks,
    };
  },

  async bridgeStatus(operationName = "bridge-status") {
    this.assertProductionProfile("Codex bridge status");
    const result = await this.run(operationName, ["route", "status"], {
      embedded: true,
      message: "Checking Codex bridge route",
      successMessage: "Codex bridge route checked",
      timeoutMs: 15_000,
    });
    return parseBridgeRouteResult(result.stdout, { requireInstalled: true });
  },

  async restoreBridgeRouteWithinOperation(operationName) {
    const current = await this.bridgeStatus(operationName);
    if (!current.installed || !current.active) return current;
    const disconnected = await this.run(operationName, ["route", "disconnect"], {
      embedded: true,
      message: "Restoring the previous Codex route",
      successMessage: "Previous Codex route restored",
      timeoutMs: 15_000,
    });
    const result = parseBridgeRouteResult(disconnected.stdout, { expectedActive: false });
    const verified = await this.bridgeStatus(operationName);
    if (!verified.installed || verified.active) {
      throw new Error("Codex bridge route restore did not persist in the active config");
    }
    return {
      ...result,
      installed: true,
    };
  },

  async restoreBridgeRoute(operationName = "bridge-route-restore") {
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    this.lifecycleOperation = operationName;
    try {
      return await this.restoreBridgeRouteWithinOperation(operationName);
    } finally {
      this.lifecycleOperation = null;
    }
  },

  async setBridgeEnabled(enabled) {
    this.assertProductionProfile("Codex bridge routing");
    const desired = enabled === true;
    const name = desired ? "bridge-connect" : "bridge-disconnect";
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    this.lifecycleOperation = name;
    try {
      const current = await this.bridgeStatus(name);
      if (!current.installed) throw new Error("Install the Codex integration before changing the bridge route");
      if (desired) {
        const runtime = await this.supervisor.startIfConfigured();
        if (runtime.status !== "ready") {
          throw new Error(`Local runtime is ${runtime.status}${runtime.detail ? `: ${runtime.detail}` : ""}`);
        }
        if (current.active) return current;
        try {
          const connected = await this.run(name, ["route", "connect"], {
            embedded: true,
            message: "Connecting Codex to the launcher",
            successMessage: "Codex bridge connected",
            timeoutMs: 15_000,
          });
          const result = parseBridgeRouteResult(connected.stdout, { expectedActive: true });
          const verified = await this.bridgeStatus(name);
          if (!verified.installed || !verified.active) {
            throw new Error("Codex bridge route connection did not persist in the active config");
          }
          return result;
        } catch (error) {
          let cleanupError;
          try { await this.supervisor.stopForSetup(); } catch (caught) { cleanupError = caught; }
          if (!cleanupError) throw error;
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; stopping the unused runtime also failed:`
            + ` ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        }
      }

      await this.supervisor.stopForSetup();
      if (!current.active) return current;
      try {
        const disconnected = await this.run(name, ["route", "disconnect"], {
          embedded: true,
          message: "Restoring the previous Codex route",
          successMessage: "Codex bridge disconnected",
          timeoutMs: 15_000,
        });
        const result = parseBridgeRouteResult(disconnected.stdout, { expectedActive: false });
        const verified = await this.bridgeStatus(name);
        if (!verified.installed || verified.active) {
          throw new Error("Codex bridge route restore did not persist in the active config");
        }
        return result;
      } catch (error) {
        let recoveryError;
        try {
          const runtime = await this.supervisor.startIfConfigured();
          if (runtime.status !== "ready") {
            throw new Error(`runtime recovery returned ${runtime.status}${runtime.detail ? `: ${runtime.detail}` : ""}`);
          }
        } catch (caught) {
          recoveryError = caught;
        }
        if (!recoveryError) throw error;
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; restoring the previous runtime also failed:`
          + ` ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
        );
      }
    } finally {
      this.lifecycleOperation = null;
    }
  },

  async setUseEnhancedWebSessionMode(enabled) {
    const desired = enabled === true;
    const name = "enhanced-web-session-mode-change";
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const current = this.runtimeConfigSnapshot();
    if (!current.configured || current.owner !== "launcher") {
      throw new Error("Install the launcher-owned runtime before changing enhanced Web session mode");
    }
    if (current.config.useEnhancedWebSessionMode === desired) return desired;
    if (typeof this.supervisor.configPath !== "string" || !path.isAbsolute(this.supervisor.configPath)) {
      throw new Error("Launcher runtime supervisor has no absolute configuration path");
    }

    this.lifecycleOperation = name;
    const previous = fs.readFileSync(this.supervisor.configPath, "utf8");
    try {
      await this.supervisor.stopForSetup();
      try {
        const { useNewCompactMode: _legacyMode, ...canonicalConfig } = current.config;
        writePrivateFileAtomic(
          this.supervisor.configPath,
          `${JSON.stringify(normalizeContextModes({
            ...canonicalConfig,
            useEnhancedWebSessionMode: desired,
          }), null, 2)}\n`,
        );
        const runtime = await this.supervisor.startIfConfigured();
        if (runtime.status !== "ready") {
          throw new Error(`Local runtime is ${runtime.status}${runtime.detail ? `: ${runtime.detail}` : ""}`);
        }
        if (!desired) this.browserHostProvider?.()?.releaseRetainedTurnTabs?.();
        return desired;
      } catch (error) {
        let recoveryError;
        try {
          writePrivateFileAtomic(this.supervisor.configPath, previous);
          const runtime = await this.supervisor.startIfConfigured();
          if (runtime.status !== "ready") {
            throw new Error(`runtime recovery returned ${runtime.status}${runtime.detail ? `: ${runtime.detail}` : ""}`);
          }
        } catch (caught) {
          recoveryError = caught;
        }
        if (!recoveryError) throw error;
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; restoring the previous Web session mode also failed:`
          + ` ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
        );
      }
    } finally {
      this.lifecycleOperation = null;
    }
  },

  async setAccountSafetySettings(input) {
    if (!input || typeof input !== "object") throw new Error("Account safety settings are invalid");
    const maxBrowserTabs = input.maxBrowserTabs;
    const automaticWebSessionLimitCount = input.automaticWebSessionLimitCount;
    const automaticWebSessionLimitMinutes = input.automaticWebSessionLimitMinutes;
    if (!Number.isInteger(maxBrowserTabs) || maxBrowserTabs < 1 || maxBrowserTabs > 6) {
      throw new Error("Maximum concurrent Web turns must be an integer from 1 to 6");
    }
    if (automaticWebSessionLimitCount !== undefined
      && (!Number.isInteger(automaticWebSessionLimitCount)
        || automaticWebSessionLimitCount < 1
        || automaticWebSessionLimitCount > 10_000)) {
      throw new Error("Automatic Web session count limit must be an integer from 1 to 10000");
    }
    if (automaticWebSessionLimitMinutes !== undefined
      && (!Number.isInteger(automaticWebSessionLimitMinutes)
        || automaticWebSessionLimitMinutes < 1
        || automaticWebSessionLimitMinutes > 10_080)) {
      throw new Error("Automatic Web session limit must be an integer from 1 to 10080 minutes");
    }
    const name = "account-safety-settings-change";
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const current = this.runtimeConfigSnapshot();
    if (!current.configured || current.owner !== "launcher") {
      throw new Error("Install the launcher-owned runtime before changing account safety settings");
    }
    if (current.config.maxBrowserTabs === maxBrowserTabs
      && current.config.automaticWebSessionLimitCount === automaticWebSessionLimitCount
      && current.config.automaticWebSessionLimitMinutes === automaticWebSessionLimitMinutes) {
      return { maxBrowserTabs, automaticWebSessionLimitCount, automaticWebSessionLimitMinutes };
    }
    if (typeof this.supervisor.configPath !== "string" || !path.isAbsolute(this.supervisor.configPath)) {
      throw new Error("Launcher runtime supervisor has no absolute configuration path");
    }

    this.lifecycleOperation = name;
    const previous = fs.readFileSync(this.supervisor.configPath, "utf8");
    try {
      await this.supervisor.stopForSetup();
      try {
        const next = { ...current.config, maxBrowserTabs };
        if (automaticWebSessionLimitMinutes === undefined) {
          delete next.automaticWebSessionLimitCount;
          delete next.automaticWebSessionLimitMinutes;
        } else {
          next.automaticWebSessionLimitCount = automaticWebSessionLimitCount;
          next.automaticWebSessionLimitMinutes = automaticWebSessionLimitMinutes;
        }
        writePrivateFileAtomic(this.supervisor.configPath, `${JSON.stringify(next, null, 2)}\n`);
        const runtime = await this.supervisor.startIfConfigured();
        if (runtime.status !== "ready") {
          throw new Error(`Local runtime is ${runtime.status}${runtime.detail ? `: ${runtime.detail}` : ""}`);
        }
        return { maxBrowserTabs, automaticWebSessionLimitCount, automaticWebSessionLimitMinutes };
      } catch (error) {
        let recoveryError;
        try {
          writePrivateFileAtomic(this.supervisor.configPath, previous);
          const runtime = await this.supervisor.startIfConfigured();
          if (runtime.status !== "ready") {
            throw new Error(`runtime recovery returned ${runtime.status}${runtime.detail ? `: ${runtime.detail}` : ""}`);
          }
        } catch (caught) {
          recoveryError = caught;
        }
        if (!recoveryError) throw error;
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; restoring the previous account safety settings also failed:`
          + ` ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
        );
      }
    } finally {
      this.lifecycleOperation = null;
    }
  },

  async accountSafetyStatus() {
    const current = this.runtimeConfigSnapshot();
    if (!current.configured || current.owner !== "launcher") throw new Error("Launcher runtime is not configured");
    const result = await this.supervisor.control(current.config, "account-safety-status");
    return result.account_safety;
  },

  async resumeAutomaticWeb() {
    const current = this.runtimeConfigSnapshot();
    if (!current.configured || current.owner !== "launcher") throw new Error("Launcher runtime is not configured");
    const result = await this.supervisor.control(current.config, "account-safety-resume");
    return result.account_safety;
  },

  async acknowledgeAccountSafetyStop() {
    const current = this.runtimeConfigSnapshot();
    if (!current.configured || current.owner !== "launcher") throw new Error("Launcher runtime is not configured");
    const result = await this.supervisor.control(current.config, "account-safety-acknowledge");
    return result.account_safety;
  },

  setUseEnhancedOutputTunnel(enabled) {
    return setRuntimeBooleanSetting(this, "useEnhancedOutputTunnel", enabled, {
      name: "enhanced-output-tunnel-change", label: "Enhanced output tunneling",
    });
  },

  mcpConnectorName() {
    const current = this.runtimeConfigSnapshot();
    if (!current.configured || current.mode !== "full") {
      throw new Error("The native MCP runtime is not configured");
    }
    return this.launcherProfile === "development"
      ? connectorNameForDevSetup(current.config?.appName)
      : requireCurrentRuntimeConnectorName(current.config?.appName);
  },

  browserConnectorName(mode = this.browserInteractionMode()) {
    const current = this.runtimeConfigSnapshot();
    const configured = mode === "manual" ? current.config?.manualAppName : current.config?.automaticAppName;
    if (this.launcherProfile === "development") {
      return connectorNameForDevSetup(configured ?? current.config?.appName);
    }
    if (!current.configured || current.mode !== "full") return configured ?? CURRENT_CONNECTOR_NAME;
    return connectorNameForSetup(configured ?? current.config?.appName);
  },

  setupConnectorName() {
    return this.launcherProfile === "development" ? DEV_CONNECTOR_NAME : CURRENT_CONNECTOR_NAME;
  },

  cancelActiveTurns() {
    this.assertProductionProfile("Launcher-owned turn cancellation");
    return this.run("cancel-active-turns", ["service", "cancel-turns"], {
      message: "Cancelling active Codex turns",
      successMessage: "Active Codex turns cancelled",
      timeoutMs: 15_000,
    });
  },

  async uninstallIntegration() {
    this.assertProductionProfile("Codex integration removal");
    const name = "uninstall-integration";
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const previousRuntime = this.runtimeConfigSnapshot();
    this.lifecycleOperation = name;
    try {
      try {
        if (previousRuntime.owner === "external") this.supervisor.prepareExternalMigration();
        else await this.supervisor.stopForSetup();
      } catch (error) {
        try {
          await this.restoreBridgeRouteWithinOperation(name);
        } catch (routeError) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; restoring the previous Codex route also failed:`
            + ` ${routeError instanceof Error ? routeError.message : String(routeError)}`,
          );
        }
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; the previous Codex route was restored,`
          + " but launcher runtime cleanup did not complete",
        );
      }
      try {
        const result = await this.run(name, ["uninstall", "--yes", "--launcher-control"], {
          embedded: true,
          env: this.launcherControlEnvironment(),
          message: "Restoring the previous Codex route",
          successMessage: "Codex Web GPT integration removed",
          timeoutMs: UNINSTALL_TIMEOUT_MS,
        });
        const verified = await this.bridgeStatus(name);
        if (verified.installed || verified.active) {
          throw new Error("Codex integration removal did not persist in the active config");
        }
        return result;
      } catch (error) {
        try {
          await this.restoreBridgeRouteWithinOperation(name);
        } catch (routeError) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; restoring the previous Codex route also failed:`
            + ` ${routeError instanceof Error ? routeError.message : String(routeError)}`,
          );
        }
        throw error;
      }
    } finally {
      this.lifecycleOperation = null;
    }
  },
};
