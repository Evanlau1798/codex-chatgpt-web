async function runSetup(name, args, options) {
  if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
  const previousRuntime = this.runtimeConfigSnapshot();
  const checkpoint = this.captureSetupCheckpoint(previousRuntime);
  this.lifecycleOperation = name;
  let setupCommandStarted = false;
  let runtimeTransitionStarted = false;
  try {
    if (this.launcherProfile === "production") {
      await this.run(name, [...args, "--preflight-only"], {
        ...options,
        message: "Validating Codex configuration before changing the runtime",
        successMessage: "Codex configuration is ready for setup",
        timeoutMs: Math.min(options.timeoutMs || 15_000, 15_000),
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
    throw new Error(message);
  } finally {
    this.lifecycleOperation = null;
  }
}

module.exports = { runSetup };
