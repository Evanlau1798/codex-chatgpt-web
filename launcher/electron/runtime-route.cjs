const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { readJsonFile } = require("./json-file.cjs");
const { connectorNameForSetup, CURRENT_CONNECTOR_NAME, isLegacyConnectorName, requireCurrentRuntimeConnectorName, validateConnectorName } = require("./connector-identity.cjs");
const { embeddedRuntimeInvocation, runtimeInvocation } = require("./runtime-command.cjs");
const { redactText } = require("./logging.cjs");
const { DETACH_OWNED_CHILD, terminateOwnedProcessTree } = require("./process-tree.cjs");
const helpers = require("./runtime-helpers.cjs");
const { MAX_CAPTURE_BYTES, MAX_RUNTIME_LOG_LINE_CHARS, CORE_SETUP_TIMEOUT_MS, MCP_SETUP_TIMEOUT_MS, UNINSTALL_TIMEOUT_MS, MAX_CHECKPOINT_FILE_BYTES, collect, resolveUserPath, captureRegularFile, restoreRegularFile, regularFileChanged, parseBridgeRouteResult } = helpers;

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

};
