import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ChatGptAccountSafety, DEFAULT_CHATGPT_AUTOMATIC_WEB_SESSION_LIMIT, defaultChatGptAccountSafetyStatePath } from "../../src/adapters/chatgpt-web/account-safety";
import { ChatGptBrowserWorker, closeChatGptBrowserWorkers } from "../../src/adapters/chatgpt-web/browser-worker";
import { closeTurnBrokers } from "../../src/adapters/chatgpt-web/turn-broker";
import { createChatCompletionExecutor, activeChatCompletionTurns } from "../../src/chat-completions/runtime";
import { defaultBrokerEndpoint, loadConfig } from "../../src/config";
import { startServer } from "../../src/server";
import type { LaneResult } from "./common";
import { waitCreateBudget } from "./common";
import { lifecycleErrorCategory } from "./artifacts";
import { PiRpcRun } from "./pi-rpc";

const MODEL = "chatgpt-web/high";
const SETTLE_MS = 10 * 60_000;

export function openPiLiveSafety(path: string, count: number | undefined, minutes: number | undefined): ChatGptAccountSafety {
  const safety = new ChatGptAccountSafety(path);
  const effectiveCount = minutes === undefined ? undefined : count ?? DEFAULT_CHATGPT_AUTOMATIC_WEB_SESSION_LIMIT;
  const status = safety.status(effectiveCount, minutes, []);
  if (status.state !== "NORMAL") throw new Error("Pi live requires account safety to be normal");
  if (effectiveCount !== undefined && effectiveCount - status.usedSessions < 4) {
    throw new Error("Pi live requires four available Automatic Web sessions");
  }
  return safety;
}

export async function closePiRpcRuns(runs: readonly Pick<PiRpcRun, "close">[]): Promise<void> {
  let failed = false;
  for (const run of runs) {
    try { await run.close(); } catch { failed = true; }
  }
  if (failed) throw new Error("Pi RPC cleanup failed");
}

export async function runPiLane(root: string, pi: string, node: string): Promise<LaneResult> {
  const current = loadConfig();
  if (current.mode !== "full" || current.browserInteractionMode !== "automatic"
    || current.browserHost !== "launcher" || !current.browserHostDescriptorPath) {
    throw new Error("Live Pi lifecycle requires the Automatic Full launcher browser host");
  }
  if (!pi || !node) throw new Error("Live Pi lifecycle requires explicit --pi and --node executables");
  const daemon = `http://${current.host}:${current.port}`;
  const headers = { authorization: `Bearer ${current.controlToken}` };
  const ownedHeaders = { ...headers, "x-account-safety-drain-owner": randomBytes(32).toString("hex") };
  const drain = await fetch(`${daemon}/admin/drain-if-idle`, {
    method: "POST", headers: ownedHeaders, signal: AbortSignal.timeout(10_000),
  });
  const drained = await drain.json() as { acquired?: boolean };
  if (!drain.ok || drained.acquired !== true) throw new Error("Pi live could not acquire an idle daemon drain");
  let safeToResume = true;
  try {
    const result = await runPiLaneDrained(root, pi, node, current);
    if (result.message?.includes("pi_cleanup_failed")) safeToResume = false;
    return result;
  } finally {
    if (!safeToResume) throw new Error("Pi cleanup failed; daemon remains drained for safe recovery");
    const resume = await fetch(`${daemon}/admin/account-safety-sync-and-resume`, {
      method: "POST", headers: ownedHeaders, signal: AbortSignal.timeout(10_000),
    });
    const resumed = await resume.json() as { accepting_turns?: boolean };
    if (!resume.ok || resumed.accepting_turns !== true) {
      throw new Error("Pi live could not sync Account Safety and resume the daemon");
    }
  }
}

async function runPiLaneDrained(root: string, pi: string, node: string, current: ReturnType<typeof loadConfig>): Promise<LaneResult> {
  const safety = openPiLiveSafety(defaultChatGptAccountSafetyStatePath(),
    current.automaticWebSessionLimitCount, current.automaticWebSessionLimitMinutes);
  const work = join(root, "pi", "work");
  const home = join(root, "pi", "home");
  const agent = join(root, "pi", "agent");
  const sessions = join(root, "pi", "sessions");
  for (const path of [work, home, agent, sessions]) mkdirSync(path, { recursive: true });
  const key = `sk-local-${randomBytes(32).toString("base64url")}`;
  const oldKey = process.env.CODEX_CHATGPT_WEB_API_KEY;
  const oldHome = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_API_KEY = key;
  process.env.CODEX_CHATGPT_WEB_HOME = home;
  const config = { ...current, host: "127.0.0.1" as const, port: 0,
    brokerSocketPath: defaultBrokerEndpoint(home) };
  let lastBrowserCompletionAt = 0;
  const executor = createChatCompletionExecutor({ safety, worker: provider => ({
    async run(turn) {
      const remaining = 30_000 - (Date.now() - lastBrowserCompletionAt);
      if (remaining > 0) await Bun.sleep(remaining);
      try { return await ChatGptBrowserWorker.forProvider(provider).run(turn); }
      finally { lastBrowserCompletionAt = Date.now(); }
    },
  }) });
  const checks: Record<string, boolean> = {};
  const runs: PiRpcRun[] = [];
  let server: ReturnType<typeof startServer> | undefined;
  let outcome: LaneResult;
  let stage = "server_start";
  try {
    server = startServer(config, { chatCompletionExecutor: executor });
    stage = "model_catalog";
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const catalog = await fetch(`${baseUrl}/v1/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    const models = catalog.ok ? await catalog.json() as { data?: Array<{ id?: string }> } : undefined;
    checks.local_connection = catalog.ok && models?.data?.some(value => value.id === MODEL) === true;
    if (!checks.local_connection) throw new Error(`Pi local model catalog failed: HTTP ${catalog.status}`);
    writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { enhanced: {
      baseUrl: `${baseUrl}/v1`, api: "openai-completions", apiKey: "$CODEX_CHATGPT_WEB_API_KEY", authHeader: true,
      models: [{ id: MODEL, name: "Enhanced High", reasoning: false, input: ["text"], contextWindow: 80000,
        maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsStore: false, supportsReasoningEffort: false, supportsDeveloperRole: true,
          supportsUsageInStreaming: false, supportsStrictMode: false, maxTokensField: "max_tokens" } }],
    } } }), { mode: 0o600 });
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false } }));
    const env = Object.fromEntries(Object.entries({ ...process.env,
      PATH: `${dirname(node)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      PI_CODING_AGENT_DIR: agent, CODEX_CHATGPT_WEB_API_KEY: key,
      HOME: home, USERPROFILE: home,
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const command = [node, pi, "--offline", "--no-context-files", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-approve", "--provider", "enhanced", "--model", MODEL,
      "--thinking", "off", "--tools", "bash", "--session-dir", sessions, "--mode", "rpc"];
    const first = new PiRpcRun(command, work, env); runs.push(first);
    stage = "initial_prompt";
    await waitCreateBudget();
    await first.send({ type: "prompt", message: "Respond only in English. Use the bash tool to run node --version once. Report the version and finish. Do not modify files, use the network, or spawn agents." });
    await first.waitFor(value => value.type === "agent_start", 30_000);
    stage = "steering";
    await first.send({ type: "steer", message: "Continue the same task. Include PI_STEER_LIVE_OK in the final answer after reporting the command result." });
    const steeringAccepted = await first.waitFor(value => value.type === "response" && value.command === "steer", 10_000);
    checks.steering_accepted = steeringAccepted.success === true;
    stage = "initial_completion";
    await first.waitFor(value => value.type === "agent_settled", SETTLE_MS);
    const commandStart = first.events.filter(value => value.type === "tool_execution_start" && value.toolName === "bash");
    checks.command_executed = commandStart.length === 1 && commandStart[0]?.commandMatched === true
      && first.events.some(value => value.type === "tool_execution_end" && value.toolCallId === commandStart[0]?.toolCallId
        && value.isError === false && value.versionObserved === true);
    checks.steering_visible = first.events.some(value => value.type === "message_end" && value.message?.role === "assistant"
      && value.message.content?.[0]?.text?.includes("steered"));
    checks.no_model_error = !first.events.some(value => value.type === "message_end" && value.message?.stopReason === "error");
    if (!checks.command_executed || !checks.steering_accepted || !checks.steering_visible || !checks.no_model_error) {
      throw new Error("Live Pi command or steering evidence was incomplete");
    }
    await first.close(); runs.pop();
    stage = "session_resume";
    const transcript = readdirSync(sessions, { recursive: true }).filter((value): value is string => typeof value === "string" && value.endsWith(".jsonl"));
    if (transcript.length !== 1) throw new Error("Live Pi did not persist one session");
    const aged = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(join(sessions, transcript[0]!), aged, aged);
    const resumed = new PiRpcRun([...command, "--continue"], work, env); runs.push(resumed);
    await resumed.send({ type: "prompt", message: "Respond only in English. State which command you ran earlier in this same Pi session and include PI_TTL_LIVE_OK. Do not run a tool." });
    await resumed.waitFor(value => value.type === "agent_settled", SETTLE_MS);
    checks.aged_session_resumed = resumed.events.some(value => value.type === "message_end" && value.message?.role === "assistant"
      && value.message.content?.[0]?.text?.includes("resumed") && value.message.content?.[0]?.text?.includes("command-mentioned"));
    checks.no_resumed_model_error = !resumed.events.some(value => value.type === "message_end" && value.message?.stopReason === "error");
    checks.no_active_api_turns = activeChatCompletionTurns() === 0;
    if (!checks.aged_session_resumed || !checks.no_resumed_model_error || !checks.no_active_api_turns) {
      throw new Error("Live Pi aged-session resume evidence was incomplete");
    }
    outcome = { lane: "pi", status: "passed", checks, timelines: [], artifacts: {} };
  } catch (error) {
    outcome = { lane: "pi", status: "failed", checks, timelines: [], artifacts: {}, message: `${lifecycleErrorCategory(error)}:${stage}` };
  } finally {
    let cleanupFailed = false;
    try {
      try { await closePiRpcRuns(runs); } catch { cleanupFailed = true; }
      try { await closeChatGptBrowserWorkers(); } catch { cleanupFailed = true; }
      try { await closeTurnBrokers(); } catch { cleanupFailed = true; }
      try { if (server) await server.stop(true); } catch { cleanupFailed = true; }
    } finally {
      if (oldKey === undefined) delete process.env.CODEX_CHATGPT_WEB_API_KEY; else process.env.CODEX_CHATGPT_WEB_API_KEY = oldKey;
      if (oldHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = oldHome;
    }
    if (cleanupFailed) outcome = { lane: "pi", status: "failed", checks, timelines: [], artifacts: {},
      message: outcome!.status === "failed" ? `${outcome!.message};pi_cleanup_failed` : "pi_cleanup_failed" };
  }
  return outcome!;
}
