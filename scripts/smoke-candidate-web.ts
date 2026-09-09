import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { type AppConfig, defaultBrokerEndpoint, loadConfig } from "../src/config";
import { VERSION } from "../src/version";
import {
  WEB_CONTRACT_PROBE_TIMEOUT_MS,
  WEB_CONTRACT_TURN_TIMEOUT_MS,
  webContractBrowserIsIdle,
} from "./lifecycle-smoke/web-contract-core";

const CONTROL_TIMEOUT_MS = 5_000;

type PromptStat = { mode: "full" | "resume" | "refresh"; chars: number; reused: boolean };

const repo = resolve(import.meta.dir, "..");
const require = createRequire(import.meta.url);
const { validateRuntimeBundle } = require("../launcher/electron/runtime-install.cjs") as {
  validateRuntimeBundle(root: string, identity: { version: string; platform: string; arch: string }): string;
};

export function candidateWebConfig(
  current: AppConfig,
  home: string,
  port: number,
): AppConfig {
  return {
    ...current,
    releaseVersion: VERSION,
    host: "127.0.0.1",
    port,
    brokerSocketPath: defaultBrokerEndpoint(home),
    experimentalNoAutoCompact: true,
  };
}

async function waitForHealth(baseUrl: string, pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS) });
      const health = response.ok ? await response.json() as Record<string, unknown> : undefined;
      if (health?.version === VERSION && health.pid === pid) return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error("Candidate runtime did not become healthy");
}

async function control(baseUrl: string, action: "drain" | "shutdown", token: string): Promise<void> {
  const response = await fetch(`${baseUrl}/admin/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Candidate runtime refused ${action}: HTTP ${response.status}`);
}

async function waitForBrowserIdle(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS) });
    if (response.ok && webContractBrowserIsIdle(await response.json() as Record<string, unknown>)) return;
    await Bun.sleep(50);
  }
  throw new Error("Candidate runtime did not become browser-idle after drain");
}

async function waitForExit(child: Bun.Subprocess, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited.then(() => true),
      new Promise<false>(resolveTimeout => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function terminate(child: Bun.Subprocess): Promise<void> {
  if (await waitForExit(child, 100)) return;
  child.kill();
  if (await waitForExit(child, 5_000)) return;
  child.kill(9);
  if (!await waitForExit(child, 5_000)) throw new Error("Candidate runtime cleanup timed out");
}

async function stopCandidate(child: Bun.Subprocess, baseUrl: string, token: string): Promise<void> {
  let gracefulError: unknown;
  try {
    await control(baseUrl, "drain", token);
    await waitForBrowserIdle(baseUrl);
    await control(baseUrl, "shutdown", token);
    if (!await waitForExit(child, 5_000)) throw new Error("Candidate runtime did not exit after shutdown");
    return;
  } catch (error) {
    gracefulError = error;
  }
  await terminate(child);
  throw gracefulError;
}

async function runWebContract(env: Record<string, string | undefined>): Promise<void> {
  const smoke = Bun.spawn([process.execPath, "run", join(repo, "scripts", "lifecycle-smoke", "web-contract.ts")], {
    cwd: repo,
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!await waitForExit(smoke, WEB_CONTRACT_PROBE_TIMEOUT_MS + WEB_CONTRACT_TURN_TIMEOUT_MS + 30_000)) {
    await terminate(smoke);
    throw new Error("Candidate Web smoke timed out");
  }
  const exitCode = await smoke.exited;
  if (exitCode !== 0) throw new Error("Candidate runtime Web contract smoke failed");
}

async function observeCandidateOutput(
  stream: ReadableStream<Uint8Array>,
  stats: PromptStat[],
): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    process.stdout.write(text);
    pending += text;
    for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      const match = /promptMode=(full|resume|refresh) promptChars=(\d+) reused=(true|false)/.exec(line);
      if (match) stats.push({
        mode: match[1] as PromptStat["mode"],
        chars: Number(match[2]),
        reused: match[3] === "true",
      });
    }
  }
  process.stdout.write(decoder.decode());
}

async function verifyRetainedRefreshStats(stats: PromptStat[]): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (stats.length < 2 && Date.now() < deadline) await Bun.sleep(25);
  const full = stats.find(value => value.mode === "full" && !value.reused);
  const refresh = stats.find(value => value.mode === "refresh" && value.reused);
  if (!full || !refresh || refresh.chars >= full.chars * 0.3) {
    throw new Error(`Candidate retained refresh evidence is invalid: ${JSON.stringify(stats)}`);
  }
  process.stdout.write(`CANDIDATE_RETAINED_REFRESH_OK ${JSON.stringify({
    fullPromptChars: full.chars,
    refreshPromptChars: refresh.chars,
    promptMode: refresh.mode,
    tabReused: refresh.reused,
  })}\n`);
}

async function main(): Promise<void> {
  const runtimeRoot = resolve(process.argv[2] ?? "");
  validateRuntimeBundle(runtimeRoot, { version: VERSION, platform: process.platform, arch: process.arch });
  const manifest = JSON.parse(readFileSync(join(runtimeRoot, "manifest.json"), "utf8")) as {
    entrypoint?: unknown;
  };
  if (typeof manifest.entrypoint !== "string") throw new Error("Candidate runtime manifest has no entrypoint");
  const runtimeCommand = [
    join(runtimeRoot, "runtime", process.platform === "win32" ? "bun.exe" : "bun"),
    join(runtimeRoot, manifest.entrypoint),
  ];
  const current = loadConfig();
  if (current.mode !== "full" || current.browserHost !== "launcher" || !current.browserHostDescriptorPath
    || !current.useEnhancedWebSessionMode) {
    throw new Error("Candidate Web smoke requires the Enhanced full-mode launcher browser host");
  }

  mkdirSync(join(repo, "tmp"), { recursive: true });
  const root = mkdtempSync(join(repo, "tmp", "candidate-web-"));
  let child: Bun.Subprocess | undefined;
  let baseUrl: string | undefined;
  let controlToken: string | undefined;
  let output: Promise<void> | undefined;
  const promptStats: PromptStat[] = [];
  try {
    const home = join(root, "home");
    mkdirSync(home);
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = listener.port;
    listener.stop();
    const config = candidateWebConfig(current, home, port);
    controlToken = config.controlToken;
    writeFileSync(join(home, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const env = { ...process.env, CODEX_CHATGPT_WEB_HOME: home };
    child = Bun.spawn([...runtimeCommand, "serve"], {
      cwd: runtimeRoot,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
    });
    output = observeCandidateOutput(child.stdout as ReadableStream<Uint8Array>, promptStats);
    baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, child.pid);
    await runWebContract(env);
    await verifyRetainedRefreshStats(promptStats);
  } finally {
    let cleanupError: unknown;
    try {
      if (child && baseUrl && controlToken) await stopCandidate(child, baseUrl, controlToken);
    } catch (error) {
      cleanupError = error;
    }
    try {
      await output;
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) throw cleanupError;
  }
}

if (import.meta.main) await main();
