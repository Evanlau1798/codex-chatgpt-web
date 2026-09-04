const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const DETACH_OWNED_CHILD = process.platform !== "win32";
const BOOT_TIME_CLOCK_TOLERANCE_MS = 5_000;
const CURRENT_BOOT_STARTED_AT_MS = Date.now() - (os.uptime() * 1_000);

function runtimeOwnershipPredatesCurrentBoot(state) {
  return Boolean(state
    && Date.parse(state.updatedAt) < CURRENT_BOOT_STARTED_AT_MS - BOOT_TIME_CLOCK_TOLERANCE_MS);
}

function processRunning(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves the process exists even though this user cannot signal it.
    return error?.code === "EPERM";
  }
}

function terminateOwnedProcessTree(child, signal = "SIGTERM") {
  if (!child) return;
  const pid = child.pid;
  if (!Number.isInteger(pid) || pid < 1) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (!child.kill(signal) && child.exitCode === null && child.signalCode === null) {
      throw new Error("Owned child process has no valid pid and refused termination");
    }
    return;
  }

  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
    const result = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10_000,
    });
    if ((result.error || result.status !== 0) && processRunning(pid)) {
      const detail = result.error?.message || `taskkill exited with status ${result.status ?? "unknown"}`;
      throw new Error(`Could not terminate owned Windows process tree ${pid}: ${detail}`);
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw new Error(
      `Could not terminate owned process group ${pid}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

module.exports = {
  DETACH_OWNED_CHILD,
  processRunning,
  runtimeOwnershipPredatesCurrentBoot,
  terminateOwnedProcessTree,
};
