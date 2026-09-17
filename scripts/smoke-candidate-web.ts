import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { type AppConfig, defaultBrokerEndpoint, loadConfig } from "../src/config";
import { providerConfig } from "../src/provider-config";
import { chatGptAdapterRuntimeConfig } from "../src/adapters/chatgpt-web/adapter-runtime-config";
import { closeChatGptBrowserWorkers, ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { verifyCurrentConnectorContract } from "../src/adapters/chatgpt-web/connector-contract";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { RemoteTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { releaseLauncherRetainedConversation } from "../src/launcher-browser-host";
import { VERSION } from "../src/version";
import {
  WEB_CONTRACT_PROBE_TIMEOUT_MS,
  WEB_CONTRACT_TURN_TIMEOUT_MS,
  webContractBrowserIsIdle,
} from "./lifecycle-smoke/web-contract-core";

const CONTROL_TIMEOUT_MS = 5_000;

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

export async function verifyLiveConnectorContract(current: AppConfig): Promise<void> {
  if (current.mode !== "full" || current.browserInteractionMode !== "automatic"
    || current.browserHost !== "launcher" || !current.browserHostDescriptorPath) {
    throw new Error("Live connector contract verification requires the Automatic Full launcher runtime");
  }
  const provider = providerConfig(current);
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const broker = new RemoteTurnBroker(current.brokerSocketPath);
  const capabilities = {
    ...chatGptAdapterRuntimeConfig(provider).configuredCapabilities,
    localToolsEnabled: false,
  };
  const conversationKey = createHash("sha256")
    .update(`release-connector-contract:${randomUUID()}`)
    .digest("hex");
  try {
    for (let round = 0; round < 2; round += 1) {
      const traceId = `release_connector_contract_${randomUUID().replaceAll("-", "")}_${round}`;
      const reference = await broker.register({
        cwd: repo,
        roots: [repo],
        writableRoots: [],
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        tools: [],
      }, WEB_CONTRACT_TURN_TIMEOUT_MS, traceId);
      try {
        await verifyCurrentConnectorContract(current.appName, "native", async probe => {
          await worker.run({
            traceId,
            modelId: CHATGPT_WEB_MODEL_ID,
            reasoning: "medium",
            capabilities,
            nativeConnector: true,
            prepare: async () => ({ text: probe.prompt, images: [], release: () => {} }),
            retainConversation: round === 0,
            requireRetainedConversation: round === 1,
            conversationKey,
            onTextDelta: () => {},
          });
        }, reference);
      } finally {
        await broker.revoke(reference).catch(() => {});
      }
    }
  } finally {
    await releaseLauncherRetainedConversation(current.browserHostDescriptorPath, conversationKey).catch(() => {});
    await closeChatGptBrowserWorkers();
  }
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
  const smoke = Bun.spawn([
    process.execPath,
    "run",
    join(repo, "scripts", "lifecycle-smoke", "web-contract.ts"),
    "--external-connector-contract-verified",
  ], {
    cwd: repo,
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!await waitForExit(smoke, WEB_CONTRACT_PROBE_TIMEOUT_MS + 2 * WEB_CONTRACT_TURN_TIMEOUT_MS + 30_000)) {
    await terminate(smoke);
    throw new Error("Candidate Web smoke timed out");
  }
  const exitCode = await smoke.exited;
  if (exitCode !== 0) throw new Error("Candidate runtime Web contract smoke failed");
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
  await verifyLiveConnectorContract(current);

  mkdirSync(join(repo, "tmp"), { recursive: true });
  const root = mkdtempSync(join(repo, "tmp", "candidate-web-"));
  let child: Bun.Subprocess | undefined;
  let baseUrl: string | undefined;
  let controlToken: string | undefined;
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
      stdout: "inherit",
      stderr: "inherit",
    });
    baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, child.pid);
    await runWebContract(env);
  } finally {
    let cleanupError: unknown;
    try {
      if (child && baseUrl && controlToken) await stopCandidate(child, baseUrl, controlToken);
    } catch (error) {
      cleanupError = error;
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
