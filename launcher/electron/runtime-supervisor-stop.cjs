const { processRunning, runtimeOwnershipPredatesCurrentBoot } = require("./process-tree.cjs");

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function appendFailure(primary, label, failure) {
  return `${primary}; ${label}: ${errorMessage(failure)}`;
}

function runtimeOwnershipMayBeLive(state) {
  if (!state || runtimeOwnershipPredatesCurrentBoot(state)) return false;
  if (processRunning(state.daemonPid) || processRunning(state.tunnelPid)) return true;
  return ["starting", "ready", "degraded", "stopping"].includes(state.status);
}

async function acquireBrowserDrain(supervisor, config) {
  try {
    const health = await supervisor.control(config, "drain");
    if (health?.status !== "ok" || health.accepting_turns !== false
      || !Number.isInteger(health.active_browser_turns) || health.active_browser_turns < 0) {
      throw new Error("daemon did not acknowledge the browser-idle drain contract");
    }
    if (health.active_browser_turns !== 0) {
      throw new Error(`daemon has ${health.active_browser_turns} active browser turn(s)`);
    }
    return true;
  } catch (error) {
    try {
      const resumed = await supervisor.control(config, "resume");
      if (resumed?.status !== "ok" || resumed.accepting_turns !== true) {
        throw new Error("daemon did not acknowledge resume");
      }
    } catch (resumeError) {
      throw new Error(appendFailure(errorMessage(error), "compensating resume failed", resumeError));
    }
    throw error;
  }
}

async function performStopForSetup({ browserOnly = false } = {}) {
  if (this.startPromise) {
    try {
      await this.startPromise;
    } catch (error) {
      this.logger.warn("runtime.start_failed_before_stop", { message: errorMessage(error) });
    }
  }
  const config = this.readConfig();
  this.stopping = true;
  this.stopTunnelMonitor();
  for (const name of ["daemon", "tunnel"]) {
    if (this.restartTimers[name]) {
      clearTimeout(this.restartTimers[name]);
      this.restartTimers[name] = null;
    }
  }
  if (this.recoveryTasks.size > 0) {
    await Promise.allSettled([...this.recoveryTasks]);
  }
  let drained = false;
  let tunnelStopped = false;
  try {
    const ownershipState = this.readState();
    const healthyRuntime = config && this.launcherProfile !== "development"
      ? await this.proxyHealth(config)
      : false;
    const runtimeMayBeLive = healthyRuntime || runtimeOwnershipMayBeLive(ownershipState);
    if (config?.mode === "full"
      && !this.tunnel
      && (runtimeMayBeLive || !ownershipState)) {
      await this.adoptConfiguredTunnelForStop(config);
    }
    if (!this.daemon && !this.tunnel) {
      if (!config) {
        if (ownershipState && !runtimeOwnershipPredatesCurrentBoot(ownershipState) && (
          processRunning(ownershipState.daemonPid)
          || processRunning(ownershipState.tunnelPid)
        )) {
          throw new Error("runtime configuration is missing while launcher ownership processes are still alive");
        }
      } else if (runtimeMayBeLive) {
        const recovered = await this.stopStaleOwnedRuntime(config);
        if (!recovered) {
          throw new Error("an existing runtime could not be safely recovered");
        }
      }
      this.clearState();
      return { status: "stopped" };
    }
    if (this.daemon && config) {
      const daemonPid = this.daemon.pid;
      if (!Number.isInteger(daemonPid)
        || !await this.proxyHealth(config, 2_000, daemonPid)) {
        throw new Error("launcher-owned daemon did not provide matching health evidence");
      }
      drained = browserOnly ? await acquireBrowserDrain(this, config) : await this.acquireDrain(config);
      if (browserOnly) {
        // Recheck browser idleness atomically with cancellation, not through a separate health snapshot.
        const cancelled = await this.control(config, "cancel-turns-if-browser-idle");
        if (cancelled?.status !== "ok" || cancelled.browser_idle !== true
          || cancelled.active_http_turns !== 0 || cancelled.active_browser_turns !== 0) {
          throw new Error("daemon did not acknowledge browser-idle HTTP cancellation");
        }
      }
    }
    if (this.tunnel) {
      if (!config) throw new Error("launcher-owned tunnel cannot be stopped without a valid configuration");
      await this.stopTunnelGracefully(config);
      tunnelStopped = true;
    }
    if (this.daemon) {
      if (!config || !drained) {
        throw new Error("launcher-owned daemon cannot be stopped without a verified idle drain");
      }
      await this.shutdownDaemon(config);
    }
    this.clearState();
    return { status: "stopped" };
  } catch (error) {
    const compensationErrors = [];
    if (tunnelStopped && config?.mode === "full" && !this.tunnel) {
      try {
        await this.startTunnel(config);
      } catch (caught) {
        compensationErrors.push(["tunnel restart compensation failed", caught]);
      }
    }
    if (drained && config) {
      try {
        await this.restoreDrainedDaemon(config);
      } catch (caught) {
        compensationErrors.push(["daemon resume compensation failed", caught]);
      }
    }
    const message = compensationErrors.reduce(
      (current, [label, failure]) => appendFailure(current, label, failure),
      errorMessage(error),
    );
    let restoredReady = false;
    if (compensationErrors.length === 0 && config) {
      try {
        restoredReady = await this.ownedRuntimeReady(config);
      } catch {
        restoredReady = false;
      }
    }
    this.tryWriteState(restoredReady ? "ready" : "failed", message);
    throw new Error(message);
  } finally {
    this.stopping = false;
  }
}

module.exports = { errorMessage, appendFailure, runtimeOwnershipMayBeLive, performStopForSetup };
