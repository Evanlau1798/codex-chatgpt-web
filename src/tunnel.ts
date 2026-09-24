import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { unzipSync } from "fflate";
import type { AppConfig, BrowserInteractionMode, TunnelConfig } from "./config";
import { atomicWriteFile, getConfigDir, stripUtf8Bom } from "./config";
import { runCommand, runChecked } from "./process";

export const TUNNEL_VERSION = "0.0.12";
const MIGRATABLE_TUNNEL_VERSIONS = new Set(["0.0.10"]);
const RELEASE_BASE = `https://github.com/openai/tunnel-client/releases/download/v${TUNNEL_VERSION}`;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const TUNNEL_READY_TIMEOUT_MS = 120_000;
export const TUNNEL_MCP_CONNECTION_MAX_TTL = "24h";
const TUNNEL_STATUS_POLL_INTERVAL_MS = 1_000;
const WINDOWS_REMOVE_RETRY_DELAYS_MS = [100, 200, 500, 1_000, 2_000] as const;

interface TunnelInstallManifest {
  version: 1;
  tunnelClientVersion: string;
  asset: string;
  archiveSha256: string;
  binarySha256: string;
}

export function tunnelClientInstallAction(installedVersion: string): "reuse" | "upgrade" {
  if (installedVersion === TUNNEL_VERSION) return "reuse";
  if (MIGRATABLE_TUNNEL_VERSIONS.has(installedVersion)) return "upgrade";
  throw new Error(`Installed tunnel-client version ${installedVersion} is not a trusted upgrade source`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function platformAsset(): string {
  const os = process.platform === "darwin" ? "darwin"
    : process.platform === "linux" ? "linux"
      : process.platform === "win32" ? "windows"
        : undefined;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : undefined;
  if (!os || !arch) throw new Error(`openai/tunnel-client has no pinned build for ${process.platform}/${process.arch}`);
  return `tunnel-client-v${TUNNEL_VERSION}-${os}-${arch}.zip`;
}

async function fetchBytes(url: string, timeoutMs = 120_000): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) throw new Error(`Download exceeds ${MAX_DOWNLOAD_BYTES} bytes: ${url}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error(`Download exceeds ${MAX_DOWNLOAD_BYTES} bytes: ${url}`);
    return bytes;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Download timed out after ${timeoutMs}ms: ${url}`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseExpectedChecksum(text: string, asset: string): string {
  const line = text.split(/\r?\n/).find(candidate => candidate.trim().endsWith(asset));
  const checksum = line?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error(`SHA256SUMS.txt has no valid entry for ${asset}`);
  return checksum;
}

function binaryPath(): string {
  return join(getConfigDir(), "bin", process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
}

function manifestPath(): string {
  return join(getConfigDir(), "bin", "tunnel-client-manifest.json");
}

/** Remove only a file explicitly owned by this install, never sweep other staging files. */
async function removeTunnelInstallFile(path: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(path, { force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      const delay = WINDOWS_REMOVE_RETRY_DELAYS_MS[attempt];
      if (process.platform !== "win32" || (code !== "EBUSY" && code !== "EPERM") || delay === undefined) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

function tunnelInstallRecoveryError(primary: unknown, failures: unknown[], operation: string): Error {
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  return new AggregateError([primary, ...failures],
    `${message(primary)}; tunnel-client ${operation} also failed: ${failures.map(message).join("; ")}`,
    { cause: primary });
}

export async function installTunnelClient(): Promise<string> {
  const executable = binaryPath();
  const manifestFile = manifestPath();
  let previousInstallation: { binary: Uint8Array; manifestText: string } | undefined;
  if (existsSync(executable) && existsSync(manifestFile)) {
    const manifestText = readFileSync(manifestFile, "utf8");
    const manifest = JSON.parse(stripUtf8Bom(manifestText)) as Partial<TunnelInstallManifest>;
    const installedBinary = new Uint8Array(readFileSync(executable));
    const actual = sha256(installedBinary);
    if (manifest.version !== 1 || typeof manifest.tunnelClientVersion !== "string"
      || manifest.binarySha256 !== actual) {
      throw new Error(`Existing tunnel-client failed integrity validation: ${executable}`);
    }
    if (process.platform !== "win32" && (statSync(executable).mode & 0o111) === 0) {
      throw new Error(`Existing tunnel-client is not executable: ${executable}`);
    }
    const action = tunnelClientInstallAction(manifest.tunnelClientVersion);
    const installedVersion = runChecked(executable, ["--version"], { timeout: 10_000 });
    if (!installedVersion.stdout.includes(manifest.tunnelClientVersion)
      && !installedVersion.stderr.includes(manifest.tunnelClientVersion)) {
      throw new Error(`Existing tunnel-client did not report version ${manifest.tunnelClientVersion}`);
    }
    if (action === "reuse") return executable;
    previousInstallation = { binary: installedBinary, manifestText };
  }
  if (!previousInstallation && (existsSync(executable) || existsSync(manifestFile))) {
    await removeTunnelInstallFile(executable);
    await removeTunnelInstallFile(manifestFile);
  }

  const asset = platformAsset();
  const [archive, sums] = await Promise.all([
    fetchBytes(`${RELEASE_BASE}/${asset}`),
    fetchBytes(`${RELEASE_BASE}/SHA256SUMS.txt`),
  ]);
  const expected = parseExpectedChecksum(new TextDecoder().decode(sums), asset);
  const archiveHash = sha256(archive);
  if (archiveHash !== expected) throw new Error(`Checksum mismatch for ${asset}`);
  const files = unzipSync(archive);
  const expectedName = process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client";
  const entry = Object.entries(files).find(([name]) => basename(name) === expectedName);
  if (!entry) throw new Error(`${asset} does not contain ${expectedName}`);
  const binary = entry[1];
  mkdirSync(dirname(executable), { recursive: true, mode: 0o700 });
  const stagedExecutable = `${executable}.install-${process.pid}-${randomUUID()}${process.platform === "win32" ? ".exe" : ""}`;
  atomicWriteFile(stagedExecutable, binary);
  try {
    if (process.platform !== "win32") chmodSync(stagedExecutable, 0o700);
    const version = runChecked(stagedExecutable, ["--version"], { timeout: 10_000 });
    if (!version.stdout.includes(TUNNEL_VERSION) && !version.stderr.includes(TUNNEL_VERSION)) {
      throw new Error(`Installed tunnel-client did not report version ${TUNNEL_VERSION}`);
    }
  } catch (error) {
    try { await removeTunnelInstallFile(stagedExecutable); }
    catch (cleanupError) { throw tunnelInstallRecoveryError(error, [cleanupError], "temporary file cleanup"); }
    throw error;
  }
  await removeTunnelInstallFile(stagedExecutable);
  const manifest: TunnelInstallManifest = {
    version: 1,
    tunnelClientVersion: TUNNEL_VERSION,
    asset,
    archiveSha256: archiveHash,
    binarySha256: sha256(binary),
  };
  try {
    atomicWriteFile(executable, binary);
    if (process.platform !== "win32") chmodSync(executable, 0o700);
    atomicWriteFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    const failures: unknown[] = [];
    if (previousInstallation) {
      try {
        atomicWriteFile(executable, previousInstallation.binary);
        if (process.platform !== "win32") chmodSync(executable, 0o700);
        atomicWriteFile(manifestFile, previousInstallation.manifestText);
      } catch (rollbackError) { failures.push(rollbackError); }
    } else {
      for (const path of [executable, manifestFile]) {
        try { await removeTunnelInstallFile(path); }
        catch (cleanupError) { failures.push(cleanupError); }
      }
    }
    if (failures.length > 0) throw tunnelInstallRecoveryError(error, failures, "rollback");
    throw error;
  }
  return executable;
}

export function installRuntimeKey(
  sourcePath: string,
  interactionMode: BrowserInteractionMode = "automatic",
): string {
  if (!existsSync(sourcePath)) throw new Error(`Tunnel runtime key file does not exist: ${sourcePath}`);
  const key = readFileSync(sourcePath);
  if (key.byteLength === 0 || key.byteLength > 64 * 1024) throw new Error("Tunnel runtime key file is empty or unexpectedly large");
  return installRuntimeKeyBytes(key, interactionMode);
}

export function managedRuntimeKeyPath(interactionMode: BrowserInteractionMode = "automatic"): string {
  const fileName = interactionMode === "manual"
    ? "tunnel-runtime-zero-risk.key"
    : "tunnel-runtime-automatic.key";
  return join(getConfigDir(), "secrets", fileName);
}

export function installRuntimeKeyBytes(
  key: Uint8Array | string,
  interactionMode: BrowserInteractionMode = "automatic",
): string {
  const bytes = typeof key === "string" ? new TextEncoder().encode(key.trim()) : key;
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) throw new Error("Tunnel runtime key is empty or unexpectedly large");
  const destination = managedRuntimeKeyPath(interactionMode);
  atomicWriteFile(destination, bytes);
  return destination;
}

export function createTunnelConfig(options: {
  binaryPath: string;
  tunnelId: string;
  runtimeKeyFile: string;
  profileName?: string;
  alias?: string;
}): TunnelConfig {
  if (!/^tunnel_[a-f0-9]{32}$/.test(options.tunnelId)) throw new Error("--tunnel-id must be tunnel_ followed by 32 lowercase hexadecimal characters");
  const profileName = options.profileName ?? "codex-chatgpt-web";
  const alias = options.alias ?? "codex-chatgpt-web";
  if (!/^[A-Za-z0-9._-]+$/.test(profileName) || !/^[A-Za-z0-9._-]+$/.test(alias)) {
    throw new Error("Tunnel profile and alias may contain only letters, digits, dot, underscore, and dash");
  }
  return {
    binaryPath: options.binaryPath,
    tunnelId: options.tunnelId,
    runtimeKeyFile: options.runtimeKeyFile,
    profileDir: join(getConfigDir(), "tunnel", "profiles"),
    profileName,
    alias,
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function tunnelCommandQuoted(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("Tunnel MCP command values must not contain newlines");
  // tunnel-client parses mcp.command with backslash escapes on every platform.
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function mcpCommand(config: AppConfig, platform = process.platform): string {
  const contract = config.browserInteractionMode === "manual" ? "safe" : "native";
  const command = [
    ...config.runtimeCommand,
    "mcp",
    "--contract",
    contract,
    "--broker-socket",
    config.brokerSocketPath,
  ];
  if (platform === "win32") {
    return command.map(tunnelCommandQuoted).join(" ");
  }
  return command.map(shellQuote).join(" ");
}

function tunnel(config: AppConfig): TunnelConfig {
  if (config.mode !== "full" || !config.tunnel) throw new Error("Tunnel commands require full mode");
  return config.tunnel;
}

export function connectTunnel(config: AppConfig): void {
  const settings = tunnel(config);
  mkdirSync(settings.profileDir, { recursive: true, mode: 0o700 });
  const result = runCommand(settings.binaryPath, [
    "runtimes", "connect",
    "--alias", settings.alias,
    "--profile", settings.profileName,
    "--profile-dir", settings.profileDir,
    "--tunnel-client-bin", settings.binaryPath,
    "--tunnel-id", settings.tunnelId,
    "--runtime-api-key", `file:${settings.runtimeKeyFile}`,
    "--mcp-command", mcpCommand(config),
    "--json",
  ], { timeout: TUNNEL_READY_TIMEOUT_MS });
  const structuredOutput = result.stdout.trim();
  const launchError = structuredOutput
    ? tunnelConnectLaunchError(structuredOutput)
    : undefined;
  if (result.status !== 0) {
    const detail = launchError && launchError !== "tunnel-client returned non-JSON connect output"
      ? launchError
      : safeTunnelDetail(tunnelCommandOutput(result) || `exit ${result.status}`);
    throw new Error(`Tunnel managed startup failed: ${detail}`);
  }
  if (launchError) throw new Error(`Tunnel runtime exited during launch: ${launchError}`);
}

export function stopTunnel(config: AppConfig): void {
  const settings = tunnel(config);
  const result = runCommand(
    settings.binaryPath,
    ["runtimes", "stop", settings.alias, "--json"],
    { timeout: 15_000 },
  );
  if (result.status !== 0
    && !/not found|not running|unknown alias|\balias\b[^\r\n]{0,160}\bis not known\b/i.test(
      `${result.stdout}\n${result.stderr}`,
    )) {
    // v0.0.12 clears its saved PID even when SIGTERM times out. Its subsequent
    // "stopped" inventory is not exit evidence; probe the PID from the stop error.
    if (tunnelStopProcessExited(result.stdout, settings.alias)) {
      console.warn("[codex-chatgpt-web] tunnel stop timed out; OS confirmed process exit");
      return;
    }
    throw new Error(`Failed to stop tunnel runtime: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

function tunnelStopProcessExited(output: string, alias: string): boolean {
  let pid: number;
  try {
    const result = JSON.parse(output);
    if (result?.alias !== alias || typeof result.stop_error !== "string") return false;
    const match = /^process ([1-9]\d*) did not exit after SIGTERM$/.exec(result.stop_error);
    if (!match) return false;
    pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  } catch { return false; }
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException)?.code === "ESRCH"; }
  return false;
}

export interface TunnelRuntimeStatus {
  ok: boolean;
  processRunning: boolean;
  healthy: boolean;
  ready: boolean;
  state?: string;
  detail: string;
}

export function tunnelCommandOutput(result: {
  status: number;
  stdout: string;
  stderr: string;
}): string {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  return result.status === 0
    ? (stdout || stderr)
    : [stderr, stdout].filter(Boolean).join("\n");
}

function safeTunnelDetail(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text
    .replace(/tunnel_[a-f0-9]{32}/g, "[tunnel-id]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted-key]")
    .slice(0, 2_000);
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : undefined;
}

function runtimeLogTail(parsed: Record<string, unknown>): string | undefined {
  const launchTail = nestedRecord(parsed, "launch_diagnostics")?.log_tail;
  if (typeof launchTail === "string" && launchTail.trim()) return launchTail.trim();
  const statusTail = nestedRecord(nestedRecord(parsed, "local"), "log")?.tail;
  return typeof statusTail === "string" && statusTail.trim() ? statusTail.trim() : undefined;
}

export function tunnelConnectLaunchError(output: string): string | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(output) as Record<string, unknown>;
  } catch {
    return "tunnel-client returned non-JSON connect output";
  }
  const running = parsed.running === true;
  const healthy = parsed.healthy === true;
  const ready = parsed.ready === true;
  if (running && healthy) return undefined;
  const diagnostics = nestedRecord(parsed, "launch_diagnostics");
  const exitCode = typeof parsed.exit_code === "number" ? parsed.exit_code
    : typeof diagnostics?.exit_code === "number" ? diagnostics.exit_code
      : undefined;
  const remoteError = typeof parsed.remote_error === "string" && parsed.remote_error.trim()
    ? parsed.remote_error.trim()
    : undefined;
  const logTail = runtimeLogTail(parsed);
  return safeTunnelDetail([
    `running=${running}`,
    `healthy=${healthy}`,
    `ready=${ready}`,
    ...(exitCode !== undefined ? [`exit_code=${exitCode}`] : []),
    ...(remoteError ? [`remote_error=${remoteError}`] : []),
    ...(logTail ? [`runtime_log=${logTail}`] : []),
    ...(!remoteError && !logTail ? ["runtime did not complete a healthy launch"] : []),
  ].join("; "));
}

export function parseTunnelStatus(output: string, alias: string, exitStatus = 0): TunnelRuntimeStatus {
  if (exitStatus !== 0) {
    return { ok: false, processRunning: false, healthy: false, ready: false, detail: safeTunnelDetail(output) };
  }
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    if (!Array.isArray(parsed.entries)) throw new Error("local inventory has no entries array");
    const matches = parsed.entries.filter(entry => entry?.alias === alias);
    if (matches.length > 1) throw new Error("local inventory contains duplicate aliases");
    const state = matches.length === 0 ? "stopped" : matches[0].runtime_state;
    if (!["stopped", "starting", "healthy", "ready"].includes(state)) {
      throw new Error("local inventory has an unsupported runtime state");
    }
    // tunnel-client 0.0.12 derives these states from the live process and local healthz/readyz
    // probes. It does not need the optional remote control-plane lookup made by `status`.
    const processRunning = state !== "stopped";
    const healthy = state === "healthy" || state === "ready";
    const ready = state === "ready";
    const ok = processRunning && healthy && ready;
    const detail = ok
      ? "process_running=true healthy=true ready=true"
      : safeTunnelDetail([
        `process_running=${processRunning}`,
        `healthy=${healthy}`,
        `ready=${ready}`,
        `state=${state}`,
        ...(matches.length === 0 ? ["local_inventory=absent"] : []),
      ].join("; "));
    return { ok, processRunning, healthy, ready, state, detail };
  } catch (error) {
    return { ok: false, processRunning: false, healthy: false, ready: false, detail: `tunnel-client returned invalid local inventory: ${safeTunnelDetail(error instanceof Error ? error.message : String(error))}` };
  }
}

export function tunnelStatus(config: AppConfig): TunnelRuntimeStatus {
  const settings = tunnel(config);
  if (!existsSync(settings.binaryPath)) {
    return { ok: false, processRunning: false, healthy: false, ready: false, detail: `Missing ${settings.binaryPath}` };
  }
  const result = runCommand(
    settings.binaryPath,
    ["runtimes", "cleanup", "--json"],
    { timeout: 10_000 },
  );
  return parseTunnelStatus(tunnelCommandOutput(result), settings.alias, result.status);
}

export async function waitForTunnelReady(
  config: AppConfig,
  timeoutMs = TUNNEL_READY_TIMEOUT_MS,
): Promise<TunnelRuntimeStatus> {
  const deadline = Date.now() + timeoutMs;
  let status = tunnelStatus(config);
  while (!status.ok && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, TUNNEL_STATUS_POLL_INTERVAL_MS));
    status = tunnelStatus(config);
  }
  return status;
}
