"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const MAX_CHECKPOINT_FILE_BYTES = 16 * 1024 * 1024;

function captureRegularFile(filePath, { followSymlink = false } = {}) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return { path: filePath, exists: false };
    throw error;
  }
  let symlink;
  if (followSymlink && stat.isSymbolicLink()) {
    symlink = { link: fs.readlinkSync(filePath), target: fs.realpathSync(filePath) };
    stat = fs.lstatSync(symlink.target);
  }
  if (!stat.isFile()) {
    throw new Error(`Setup checkpoint path is not a regular file: ${filePath}`);
  }
  if (stat.size > MAX_CHECKPOINT_FILE_BYTES) {
    throw new Error(`Setup checkpoint file exceeds ${MAX_CHECKPOINT_FILE_BYTES} bytes: ${filePath}`);
  }
  return {
    path: filePath,
    exists: true,
    data: fs.readFileSync(symlink?.target ?? filePath),
    mode: stat.mode & 0o777,
    ...(symlink ? { symlink } : {}),
  };
}

function checkpointWritePath(snapshot) {
  if (!snapshot.symlink) return snapshot.path;
  if (!fs.lstatSync(snapshot.path).isSymbolicLink()
    || fs.readlinkSync(snapshot.path) !== snapshot.symlink.link
    || fs.realpathSync(snapshot.path) !== snapshot.symlink.target) {
    throw new Error(`Codex config symlink changed during setup: ${snapshot.path}`);
  }
  return snapshot.symlink.target;
}

function restoreRegularFile(snapshot, platform = process.platform) {
  if (!snapshot.exists) {
    fs.rmSync(snapshot.path, { force: true });
    return;
  }
  const writePath = checkpointWritePath(snapshot);
  writePrivateFileAtomic(writePath, snapshot.data, snapshot.symlink
    ? { mode: snapshot.mode, protectDirectory: false }
    : undefined);
  if (platform !== "win32") fs.chmodSync(writePath, snapshot.mode);
}

function regularFileChanged(snapshot, platform = process.platform) {
  let filePath;
  try { filePath = checkpointWritePath(snapshot); } catch { return true; }
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return snapshot.exists;
    throw error;
  }
  if (!snapshot.exists || !stat.isFile()) return true;
  if (platform !== "win32" && (stat.mode & 0o777) !== snapshot.mode) return true;
  if (stat.size > MAX_CHECKPOINT_FILE_BYTES) return true;
  return !fs.readFileSync(filePath).equals(snapshot.data);
}

module.exports = {
  captureSetupCheckpoint(snapshot, includeClaude = true) {
    if (typeof this.supervisor.configPath !== "string" || !path.isAbsolute(this.supervisor.configPath)) {
      throw new Error("Launcher runtime supervisor has no absolute configuration path for setup rollback");
    }
    const coreHome = this.supervisor.coreHome
      || path.dirname(this.supervisor.configPath);
    const paths = new Set([
      this.supervisor.configPath,
      path.join(coreHome, "codex", "integration-journal.json"),
      path.join(coreHome, "codex", "integration-journal.recovery.json"),
      path.join(this.codexHome, "config.toml"),
      path.join(this.codexHome, "models_cache.json"),
      path.join(coreHome, "secrets", "tunnel-runtime.key"),
      path.join(coreHome, "secrets", "tunnel-runtime-automatic.key"),
      path.join(coreHome, "secrets", "tunnel-runtime-zero-risk.key"),
      path.join(coreHome, "tunnel", "profiles", "codex-chatgpt-web.yaml"),
      path.join(coreHome, "tunnel", "profiles", "codex-chatgpt-web-zero-risk.yaml"),
      path.join(coreHome, "tunnel", "profiles", "codex-chatgpt-web-dev.yaml"),
      path.join(coreHome, "tunnel", "profiles", "codex-chatgpt-web-dev-zero-risk.yaml"),
    ]);
    const claudeJournal = path.join(coreHome, "claude", "integration-journal.json");
    // Existing managed Claude hooks rotate their token during setup/runtime startup.
    if (this.launcherProfile === "production" && (includeClaude || fs.existsSync(claudeJournal))) {
      paths.add(claudeJournal);
      paths.add(path.join(this.claudeHome, "settings.json"));
    }
    if (snapshot.owner === "external" && this.platform === "darwin") {
      paths.add(path.join(this.launchAgentsDir, "io.github.codex-chatgpt-web.daemon.plist"));
      paths.add(path.join(this.launchAgentsDir, "io.github.codex-chatgpt-web.tunnel.plist"));
    }
    for (const tunnel of [snapshot.config?.tunnel, snapshot.config?.automaticTunnel, snapshot.config?.manualTunnel]) {
      if (!tunnel || typeof tunnel !== "object") continue;
      if (typeof tunnel.runtimeKeyFile === "string" && tunnel.runtimeKeyFile) {
        paths.add(tunnel.runtimeKeyFile);
      }
      if (typeof tunnel.profileDir === "string"
        && tunnel.profileDir
        && typeof tunnel.profileName === "string"
        && tunnel.profileName) {
        paths.add(path.join(tunnel.profileDir, `${tunnel.profileName}.yaml`));
      }
    }
    return [...paths].map(filePath => captureRegularFile(filePath, {
      followSymlink: filePath === path.join(this.codexHome, "config.toml"),
    }));
  },

  setupCheckpointChanged(checkpoint) {
    return checkpoint ? checkpoint.some(snapshot => regularFileChanged(snapshot, this.platform)) : false;
  },

  restoreSetupCheckpoint(checkpoint) {
    if (!checkpoint) return;
    const failures = [];
    for (const snapshot of [...checkpoint].reverse()) {
      try {
        restoreRegularFile(snapshot, this.platform);
      } catch (error) {
        failures.push(`${snapshot.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`Setup checkpoint restoration failed: ${failures.join("; ")}`);
    }
  },

  async restorePreviousRuntime(snapshot, operationName, { repairExternal = false } = {}) {
    const current = this.runtimeConfigSnapshot();
    if (current.owner !== snapshot.owner || current.serialized !== snapshot.serialized) {
      throw new Error(
        "Runtime configuration changed before the operation failed; refusing to describe the current runtime as the previous installation",
      );
    }
    if (snapshot.owner === "external") {
      if (repairExternal) {
        if (this.platform !== "darwin") {
          throw new Error("Terminal-managed runtime repair is supported only on macOS");
        }
        await this.run(operationName, ["service", "install"], {
          embedded: true,
          message: "Restoring the previous terminal-managed daemon",
          successMessage: "Previous terminal-managed daemon restored",
          timeoutMs: 75_000,
        });
        if (snapshot.mode === "full") {
          await this.run(operationName, ["tunnel", "start"], {
            embedded: true,
            message: "Restoring the previous terminal-managed tunnel",
            successMessage: "Previous terminal-managed tunnel restored",
            timeoutMs: 75_000,
          });
        }
      }
      await this.run(operationName, ["doctor", "--json"], {
        message: "Verifying the previous terminal-managed runtime",
        successMessage: "Previous terminal-managed runtime is still healthy",
        timeoutMs: 75_000,
      });
      return;
    }
    const runtime = await this.supervisor.startIfConfigured();
    const expected = snapshot.configured ? "ready" : "not-configured";
    if (runtime.status !== expected) {
      throw new Error(
        `Previous runtime recovery returned ${runtime.status}; expected ${expected}${runtime.detail ? `: ${runtime.detail}` : ""}`,
      );
    }
  },

  async rollbackFirstSetup(checkpoint) {
    const changed = this.setupCheckpointChanged(checkpoint);
    let stopError;
    try {
      await this.supervisor.stopForSetup();
    } catch (error) {
      stopError = error;
    }
    let restoreError;
    try {
      this.restoreSetupCheckpoint(checkpoint);
    } catch (error) {
      restoreError = error;
    }
    this.supervisor.clearState();
    if (stopError || restoreError) {
      const failures = [
        stopError ? `stopping the incomplete runtime failed: ${stopError instanceof Error ? stopError.message : String(stopError)}` : null,
        restoreError ? (restoreError instanceof Error ? restoreError.message : String(restoreError)) : null,
      ].filter(Boolean);
      throw new Error(failures.join("; "));
    }
    return changed;
  },
};
