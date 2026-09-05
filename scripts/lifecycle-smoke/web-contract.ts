import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CHATGPT_TEMPORARY_CHAT_URL,
  detectChatGptAccountCapabilities,
  isTemporaryChatGptUrl,
} from "../../src/chatgpt-session";
import { loadConfig } from "../../src/config";
import { VERSION } from "../../src/version";
import {
  connectLauncherBrowserHost,
  inspectLauncherBrowserHost,
  LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS,
  notifyLauncherTurn,
  verifyLauncherBrowserConnector,
} from "../../src/launcher-browser-host";
import {
  assertWebContractCooldown,
  assertWebContractRuntimeVersion,
  deriveWebContractCapabilities,
  requestWebContractTurn,
  responseHasFinalProjection,
  WEB_CONTRACT_PROBE_TIMEOUT_MS,
  WEB_CONTRACT_TURN_TIMEOUT_MS,
  webContractBrowserIsIdle,
} from "./web-contract-core";
import { runMarkdownRestorationProbe } from "./markdown-restoration-probe";

const repo = resolve(import.meta.dir, "..", "..");
const artifactDir = join(repo, "tmp", "lifecycle-smoke", "web-contract");
const lastRunPath = join(artifactDir, ".last-run");
const resultPath = join(artifactDir, "latest.json");

function lastRunAt(): number | undefined {
  try {
    const value = Number(readFileSync(lastRunPath, "utf8").trim());
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function save(value: Record<string, unknown>): void {
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(resultPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function health(baseUrl: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/healthz`);
  if (!response.ok) throw new Error(`Lifecycle daemon health check failed: HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

async function waitForBrowserIdle(baseUrl: string): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  do {
    const state = await health(baseUrl);
    if (webContractBrowserIsIdle(state)) return true;
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  return false;
}

const config = loadConfig();
if (config.browserHost !== "launcher" || !config.browserHostDescriptorPath) {
  throw new Error("Web contract smoke requires the launcher-owned browser host");
}
if (config.browserInteractionMode !== "automatic") {
  throw new Error("Web contract smoke requires Automatic interaction mode");
}
if (!config.useEnhancedWebSessionMode) {
  throw new Error("Web contract smoke requires Enhanced Web Session so connector selection is exercised");
}
const baseUrl = `http://${config.host}:${config.port}`;
const before = await health(baseUrl);
if (before.status !== "ok" || before.accepting_turns !== true
  || !webContractBrowserIsIdle(before)) {
  throw new Error("Web contract smoke requires a healthy, accepting daemon without another Web turn");
}
const runtimePid = assertWebContractRuntimeVersion(before, VERSION);
const now = Date.now();
assertWebContractCooldown(lastRunAt(), now);
mkdirSync(artifactDir, { recursive: true });
writeFileSync(lastRunPath, `${now}\n`, "utf8");

const connectorVerified = await verifyLauncherBrowserConnector(config.browserHostDescriptorPath);
const inspected = await inspectLauncherBrowserHost(config.browserHostDescriptorPath, {
  detectCapabilities: false,
  expectedProfile: "production",
});
const probeTraceId = `web_contract_probe_${crypto.randomUUID().replaceAll("-", "")}`;
const lease = await notifyLauncherTurn(config.browserHostDescriptorPath, {
  phase: "start",
  traceId: probeTraceId,
  helperPid: process.pid,
  connectorIdentity: config.appName,
});
if (!lease.surfaceId) throw new Error("Web contract smoke did not receive an Automatic turn surface");
const connection = await connectLauncherBrowserHost(
  config.browserHostDescriptorPath,
  20_000,
  lease.surfaceId,
);
let account;
let markdownRestoration = false;
let probeStatus: "completed" | "failed" = "completed";
const heartbeat = setInterval(() => {
  void notifyLauncherTurn(config.browserHostDescriptorPath!, {
    phase: "heartbeat",
    traceId: probeTraceId,
    helperPid: process.pid,
  }).catch(() => {});
}, LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS);
heartbeat.unref?.();
try {
  await connection.page.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  account = await detectChatGptAccountCapabilities(connection.page);
  process.stdout.write("WEB_CONTRACT_MARKDOWN_PROBE_STARTED\n");
  markdownRestoration = await runMarkdownRestorationProbe(
    connection.page,
    config.appName,
    AbortSignal.timeout(WEB_CONTRACT_PROBE_TIMEOUT_MS),
  );
  process.stdout.write("WEB_CONTRACT_MARKDOWN_PROBE_OK\n");
} catch (error) {
  probeStatus = "failed";
  throw error;
} finally {
  clearInterval(heartbeat);
  await connection.browser.close().catch(() => {});
  await notifyLauncherTurn(config.browserHostDescriptorPath, {
    phase: "end",
    traceId: probeTraceId,
    helperPid: process.pid,
    status: probeStatus,
  });
}
const session = { ...inspected, ...account };
if (session.solAvailable !== true) throw new Error("Web contract smoke requires the ChatGPT effort control");
if (!isTemporaryChatGptUrl(session.url)) throw new Error("Web contract smoke requires Temporary Chat");

const threadId = `thread_web_contract_${crypto.randomUUID().replaceAll("-", "")}`;
const turnId = `turn_web_contract_${crypto.randomUUID().replaceAll("-", "")}`;
const environment = `<environment_context>\n  <cwd>${repo}</cwd>\n  <filesystem><workspace_roots><root>${repo}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>\n</environment_context>`;
const item = (id: string, text: string) => ({
  type: "message",
  id,
  role: "user",
  content: [{ type: "input_text", text }],
  internal_chat_message_metadata_passthrough: { turn_id: turnId },
});
const metadata = {
  thread_id: threadId,
  turn_id: turnId,
  request_kind: "turn",
  sandbox: "none",
  workspaces: { [repo]: {} },
};
const request = new Request(`${baseUrl}/v1/responses`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  signal: AbortSignal.timeout(WEB_CONTRACT_TURN_TIMEOUT_MS),
  body: JSON.stringify({
    model: "chatgpt-web/medium",
    stream: false,
    reasoning: { effort: "medium" },
    prompt_cache_key: threadId,
    client_metadata: {
      thread_id: threadId,
      "x-codex-turn-metadata": JSON.stringify(metadata),
    },
    input: [
      item("msg_web_contract_environment", environment),
      item("msg_web_contract_prompt", "Reply briefly to confirm this turn completed.\n\nVerification: **bold**, `code`, and _emphasis_."),
    ],
    tools: [],
  }),
});
const result = await requestWebContractTurn(fetch, request);
if (result.status === "account-blocked") {
  save({ status: "account-blocked", runtimeVersion: VERSION, httpStatus: 429, at: new Date(now).toISOString() });
  throw new Error("WEB_CONTRACT_ACCOUNT_BLOCKED: ChatGPT returned a rate or verification limit; no retry was attempted");
}
if (!result.response.ok) throw new Error(`Web contract turn failed: HTTP ${result.response.status}`);
const payload = await result.response.json();
const finalProjection = responseHasFinalProjection(payload);
if (!finalProjection) throw new Error("Web contract turn did not complete a final projection");
const browserIdle = await waitForBrowserIdle(baseUrl);
assertWebContractRuntimeVersion(await health(baseUrl), VERSION, runtimePid);
const capture = deriveWebContractCapabilities({
  session,
  connectorVerified,
  markdownRestoration,
  responseAccepted: result.response.ok,
  finalProjection,
  browserIdle,
});
if (Object.values(capture).some(value => !value)) throw new Error("Web contract smoke did not return browser idle");
save({ status: "passed", runtimeVersion: VERSION, at: new Date(now).toISOString(), capabilities: capture });
process.stdout.write(`WEB_CONTRACT_SMOKE_OK ${JSON.stringify(capture)}\n`);
