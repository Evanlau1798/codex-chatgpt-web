const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

async function setRuntimeBooleanSetting(host, key, enabled, operation) {
  const desired = enabled === true;
  if (host.currentOperation()) throw new Error(`Another launcher operation is active: ${host.currentOperation()}`);
  const current = host.runtimeConfigSnapshot();
  if (!current.configured || current.owner !== "launcher") {
    throw new Error(`Install the launcher-owned runtime before changing ${operation.label}`);
  }
  if (current.config[key] === desired) return desired;
  if (typeof host.supervisor.configPath !== "string" || !path.isAbsolute(host.supervisor.configPath)) {
    throw new Error("Launcher runtime supervisor has no absolute configuration path");
  }
  host.lifecycleOperation = operation.name;
  const previous = fs.readFileSync(host.supervisor.configPath, "utf8");
  try {
    await host.supervisor.stopForSetup({ browserOnly: true });
    try {
      writePrivateFileAtomic(host.supervisor.configPath, `${JSON.stringify({ ...current.config, [key]: desired }, null, 2)}\n`);
      const runtime = await host.supervisor.startIfConfigured();
      if (runtime.status !== "ready") {
        throw new Error(`Local runtime is ${runtime.status}${runtime.detail ? `: ${runtime.detail}` : ""}`);
      }
    } catch (error) {
      let recoveryError;
      try {
        writePrivateFileAtomic(host.supervisor.configPath, previous);
        const runtime = await host.supervisor.startIfConfigured();
        if (runtime.status !== "ready") throw new Error(`runtime recovery returned ${runtime.status}${runtime.detail ? `: ${runtime.detail}` : ""}`);
      } catch (caught) { recoveryError = caught; }
      if (!recoveryError) throw error;
      throw new Error(`${error instanceof Error ? error.message : String(error)}; restoring the previous setting also failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
    }
    try {
      host.browserHostProvider?.()?.releaseRetainedTurnTabs?.("automatic");
    } catch (error) {
      console.warn(`[launcher] retained-tab cleanup failed after ${operation.label} update: ${error instanceof Error ? error.message : String(error)}`);
    }
    return desired;
  } finally { host.lifecycleOperation = null; }
}

module.exports = { setRuntimeBooleanSetting };
