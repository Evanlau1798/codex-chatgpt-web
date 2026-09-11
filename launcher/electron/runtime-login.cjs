"use strict";
const path = require("node:path");
const fs = require("node:fs");
const PASSKEY_LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_PASSKEY_STATE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PASSKEY_MARKER_FILE_BYTES = 64 * 1024;

function usableExecutable(candidate, platform = process.platform) {
  if (typeof candidate !== "string" || !candidate) return false;
  const absolute = platform === "win32" ? path.win32.isAbsolute(candidate) : path.posix.isAbsolute(candidate);
  if (!absolute) return false;
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  cleanupEphemeralSecrets() {
    const secretsDir = path.join(this.app.getPath("userData"), "secrets");
    try {
      for (const entry of fs.readdirSync(secretsDir, { withFileTypes: true })) {
        if (/^runtime-key-(?:\d+|[a-f0-9]{32})\.tmp$/.test(entry.name)) {
          fs.rmSync(path.join(secretsDir, entry.name), { force: true });
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.logger.warn("runtime.secret_cleanup_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  },

  cleanupPasskeyTransfers() {
    const parent = path.join(this.app.getPath("userData"), "passkey-login");
    let entries;
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && /^transfer-[A-Za-z0-9]+$/.test(entry.name)) {
        fs.rmSync(path.join(parent, entry.name), { recursive: true, force: true });
      }
    }
  },

  passkeyChromeExecutable() {
    if (this.platform !== "darwin") throw new Error("Passkey sign-in is currently supported only on macOS");
    const setupConfig = this.supervisor.readSetupConfig
      ? this.supervisor.readSetupConfig()
      : this.supervisor.readConfig();
    const candidate = setupConfig?.chromeExecutablePath
      || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (!usableExecutable(candidate, this.platform)) {
      throw new Error(`Google Chrome is unavailable at ${candidate}`);
    }
    return candidate;
  },

  continuePasskeyLogin() {
    const child = this.activeChild;
    if (this.active !== "passkey-login"
      || this.passkeyContinuationRequested
      || !child
      || child.exitCode !== null
      || child.signalCode !== null
      || !child.stdin?.writable) {
      throw new Error("No passkey sign-in is waiting for Continue");
    }
    this.passkeyContinuationRequested = true;
    this.publishOperation?.({
      name: "passkey-login",
      status: "running",
      message: "Capturing and verifying the passkey session",
    });
    return new Promise((resolve, reject) => {
      child.stdin.write(
        `${JSON.stringify({ version: 1, type: "passkey-login-continue" })}\n`,
        error => {
          if (error) {
            this.passkeyContinuationRequested = false;
            reject(error);
          } else {
            resolve(true);
          }
        },
      );
    });
  },

  async capturePasskeyLogin() {
    this.cleanupPasskeyTransfers();
    const chrome = this.passkeyChromeExecutable();
    const parent = path.join(this.app.getPath("userData"), "passkey-login");
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(parent, 0o700); } catch {}
    const transferRoot = fs.mkdtempSync(path.join(parent, "transfer-"));
    try { fs.chmodSync(transferRoot, 0o700); } catch {}
    const storageStatePath = path.join(transferRoot, "storage-state.json");
    const markerPath = `${storageStatePath}.verified.json`;
    const cleanup = async () => fs.rmSync(transferRoot, { recursive: true, force: true });
    this.passkeyContinuationRequested = false;
    try {
      await this.run("passkey-login", [
        "login",
        "--launcher-control",
        "--chrome",
        chrome,
        "--storage-state",
        storageStatePath,
      ], {
        embedded: true,
        controlStdin: true,
        env: this.launcherControlEnvironment(),
        message: "Sign in with your passkey in Chrome, then return here and choose Continue",
        successMessage: "Passkey session captured for private Launcher verification",
        timeoutMs: PASSKEY_LOGIN_TIMEOUT_MS,
      });
      const stateStat = fs.lstatSync(storageStatePath);
      if (!stateStat.isFile() || stateStat.size < 1 || stateStat.size > MAX_PASSKEY_STATE_FILE_BYTES) {
        throw new Error("Passkey sign-in returned an invalid storage-state file");
      }
      const markerStat = fs.lstatSync(markerPath);
      if (!markerStat.isFile() || markerStat.size < 1 || markerStat.size > MAX_PASSKEY_MARKER_FILE_BYTES) {
        throw new Error("Passkey sign-in returned invalid capture evidence");
      }
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      const capturedAt = typeof marker?.capturedAt === "string" ? Date.parse(marker.capturedAt) : Number.NaN;
      if (marker?.version !== 1
        || marker?.captureComplete !== true
        || marker?.source !== "isolated-normal-browser-profile"
        || !Number.isFinite(capturedAt)
        || capturedAt < Date.now() - PASSKEY_LOGIN_TIMEOUT_MS - 60_000
        || capturedAt > Date.now() + 60_000) {
        throw new Error("Passkey sign-in did not return completed capture evidence");
      }
      return { storageState: JSON.parse(fs.readFileSync(storageStatePath, "utf8")), cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    } finally {
      this.passkeyContinuationRequested = false;
    }
  },
};
