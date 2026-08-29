import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProviderAdapter } from "../../src/adapters/base";
import {
  ChatGptSteeringFeed,
  ChatGptTextFeed,
  ChatGptTraceFeed,
  chatGptTurnSessions,
} from "../../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig } from "../../src/config";
import { claudeSessionThreadId } from "../../src/messages/request";
import { startServer } from "../../src/server";
import { buildClaudeSmokeSettings } from "../lifecycle-smoke/claude-config";
import { resolveLifecycleExecutable } from "../lifecycle-smoke/paths";
import { assertLifecycleEvidence, assertSingleLifecycleEvidence } from "./evidence";

const repo = resolve(import.meta.dir, "..", "..");
const executableArgument = process.argv.find(argument => argument.startsWith("--claude="));
const claude = executableArgument?.slice("--claude=".length) || resolveLifecycleExecutable("claude");
const root = join(tmpdir(), `codex-chatgpt-web-claude-lifecycle-${process.pid}-${Date.now()}`);
const configDir = join(root, "config");
const settingsPath = join(configDir, "settings.json");
const sessionId = crypto.randomUUID();
const evidence: string[] = [];
const steeringInstruction = "CLAUDE_LIFECYCLE_STEERING_APPLIED";
let steeringTurnStarted!: () => void;
let interruptStarted!: () => void;
let interruptAborted!: () => void;
const started = new Promise<void>(resolveStarted => { interruptStarted = resolveStarted; });
const aborted = new Promise<void>(resolveAborted => { interruptAborted = resolveAborted; });
const steeringReady = new Promise<void>(resolveStarted => { steeringTurnStarted = resolveStarted; });

function lifecycleAdapter(): ProviderAdapter {
  return {
    name: "deterministic-claude-lifecycle",
    async runTurn(parsed, incoming, emit) {
      const context = JSON.stringify(parsed.context.messages);
      const metadata = parsed._rawBody && typeof parsed._rawBody === "object"
        && !Array.isArray(parsed._rawBody)
        && (parsed._rawBody as { client_metadata?: unknown }).client_metadata
        && typeof (parsed._rawBody as { client_metadata?: unknown }).client_metadata === "object"
        ? (parsed._rawBody as { client_metadata: Record<string, unknown> }).client_metadata
        : {};
      if (metadata.claude_subagent === true) {
        evidence.push("subagent_request");
        emit({ type: "text_delta", text: "CLAUDE_LIFECYCLE_CHILD_DONE", phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
        return;
      }
      const compact = parsed.context.systemPrompt?.some(prompt => prompt.includes(
        "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.",
      )) && context.includes("Your task is to create a detailed summary of this conversation.");
      if (compact) {
        evidence.push("compact");
        emit({ type: "text_delta", text: "The deterministic lifecycle was compacted.", phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
        return;
      }
      if (context.includes("CLAUDE_LIFECYCLE_INTERRUPT")) {
        evidence.push("interrupt");
        interruptStarted();
        await new Promise<void>(resolveAbort => {
          if (incoming.abortSignal?.aborted) resolveAbort();
          else incoming.abortSignal?.addEventListener("abort", () => resolveAbort(), { once: true });
        });
        interruptAborted();
        return;
      }
      if (context.includes("CLAUDE_LIFECYCLE_STEERING_WAIT")) {
        evidence.push("resume", "steering_active");
        const feed = new ChatGptSteeringFeed();
        let settleBrowser!: (value: string) => void;
        const sessionKey = `claude-lifecycle-steering-${sessionId}`;
        const session = chatGptTurnSessions.getOrCreate(sessionKey, () => ({
          mode: "read-only",
          browser: new Promise<string>(resolveBrowser => { settleBrowser = resolveBrowser; }),
          trace: new ChatGptTraceFeed(),
          text: new ChatGptTextFeed(),
          steering: feed,
          cancel: () => settleBrowser("cancelled"),
        }), undefined, undefined, claudeSessionThreadId(sessionId), sessionKey);
        steeringTurnStarted();
        try {
          const deadline = Date.now() + 10_000;
          while (!session.peekPendingClaudeSteering() && Date.now() < deadline) await Bun.sleep(20);
          const pending = session.peekPendingClaudeSteering();
          const delivered = session.acknowledgePendingClaudeSteering(pending?.count ?? 0);
          if (delivered !== steeringInstruction) {
            throw new Error(`Claude steering was not delivered exactly once: ${delivered ?? "none"}`);
          }
          evidence.push("steering");
          emit({ type: "text_delta", text: steeringInstruction, phase: "final_answer" });
          emit({ type: "done", stopReason: "stop", endTurn: true });
        } finally {
          settleBrowser("completed");
          chatGptTurnSessions.retire(sessionKey, session);
        }
        return;
      }
      if (context.includes("CLAUDE_LIFECYCLE_CHILD_DONE")) {
        if (!evidence.includes("subagent_result")) evidence.push("subagent_result");
        emit({ type: "text_delta", text: "CLAUDE_LIFECYCLE_TOOL_DONE", phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
        return;
      }
      if (context.includes("CLAUDE_LIFECYCLE_TOOL_OK")) {
        if (!evidence.includes("tool_result")) evidence.push("tool_result");
        emit({ type: "tool_call_start", id: "toolu_lifecycle_agent", name: "Agent" });
        emit({
          type: "tool_call_delta",
          arguments: JSON.stringify({
            description: "Verify deterministic lifecycle",
            prompt: "Reply with exactly CLAUDE_LIFECYCLE_CHILD_DONE.",
            subagent_type: "general-purpose",
          }),
        });
        emit({ type: "tool_call_end" });
        emit({ type: "done", stopReason: "tool_use", endTurn: false });
        return;
      }
      evidence.push("request", "tool_call");
      emit({ type: "tool_call_start", id: "toolu_lifecycle", name: "Bash" });
      emit({ type: "tool_call_delta", arguments: '{"command":"echo CLAUDE_LIFECYCLE_TOOL_OK"}' });
      emit({ type: "tool_call_end" });
      emit({ type: "done", stopReason: "tool_use", endTurn: false });
    },
  };
}

async function runClaude(prompt: string, resume = false): Promise<string> {
  const args = [
    "-p", resume ? "--resume" : "--session-id", sessionId,
    "--model", "claude-chatgpt-web-high", "--effort", "high",
    "--autocompact", "100k",
    "--output-format", "json", "--tools", "Bash,Agent,TaskOutput",
    "--permission-mode", "bypassPermissions", "--verbose", "--settings", settingsPath,
    prompt,
  ];
  const child = Bun.spawn([claude, ...args], {
    cwd: repo,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, CODEX_CHATGPT_WEB_CONTROL_TOKEN: config.controlToken },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 30_000);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Claude lifecycle command exited ${code}: ${stderr.slice(-2_000)}`);
  return stdout;
}

async function runCompactRequest(): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-claude-code-session-id": sessionId },
    body: JSON.stringify({
      model: "chatgpt-web/high",
      max_tokens: 4096,
      system: "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.",
      messages: [{
        role: "user",
        content: "Your task is to create a detailed summary of this conversation. Preserve the implementation state.",
      }],
    }),
  });
  const body = await response.text();
  const bodyHasSummary = body.includes("The deterministic lifecycle was compacted.");
  const evidenceHasCompact = evidence.includes("compact");
  if (!response.ok || !bodyHasSummary || !evidenceHasCompact) {
    throw new Error(`Claude compact route failed: HTTP ${response.status} body=${bodyHasSummary} adapter=${evidenceHasCompact}`);
  }
}

async function runInterruptRequest(): Promise<void> {
  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
    method: "POST",
    signal: controller.signal,
    headers: { "content-type": "application/json", "x-claude-code-session-id": sessionId },
    body: JSON.stringify({
      model: "chatgpt-web/high",
      max_tokens: 4096,
      messages: [{ role: "user", content: "Hold CLAUDE_LIFECYCLE_INTERRUPT until the client closes." }],
    }),
  }).catch(error => error);
  await waitFor(started, "Claude interrupt request");
  controller.abort();
  await request;
  await waitFor(aborted, "Claude interrupt propagation");
}

async function runSteeringTurn(): Promise<void> {
  const running = runClaude("Hold CLAUDE_LIFECYCLE_STEERING_WAIT until steering arrives.", true);
  await waitFor(steeringReady, "Claude steering turn");
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages/steering`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.controlToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      prompt: steeringInstruction,
    }),
  });
  if (response.status !== 204) throw new Error(`Claude steering hook failed: HTTP ${response.status}`);
  if (!(await running).includes(steeringInstruction)) throw new Error("Claude CLI did not receive steering completion");
}

async function waitFor(promise: Promise<void>, label: string): Promise<void> {
  await Promise.race([
    promise,
    Bun.sleep(10_000).then(() => { throw new Error(`${label} timed out`); }),
  ]);
}

mkdirSync(configDir, { recursive: true });
const config = defaultConfig("browser-only");
config.port = 0;
config.proAvailable = true;
const server = startServer(config, { adapterFactory: lifecycleAdapter });
config.port = server.port!;
writeFileSync(settingsPath, `${JSON.stringify(buildClaudeSmokeSettings(config), null, 2)}\n`, "utf8");
writeFileSync(join(configDir, ".claude.json"), '{"autoCompactEnabled":true}\n', "utf8");

try {
  const initial = await runClaude("Use Bash once, then finish the CLAUDE_LIFECYCLE_INITIAL request.");
  if (!initial.includes("CLAUDE_LIFECYCLE_TOOL_DONE")) throw new Error("Claude did not complete its deterministic tool loop");
  await runCompactRequest();
  await runInterruptRequest();
  await runSteeringTurn();
  const health = await fetch(`http://127.0.0.1:${server.port}/healthz`).then(response => response.json()) as Record<string, unknown>;
  if (health.active_http_turns !== 0 || health.active_browser_turns !== 0) {
    throw new Error(`Claude lifecycle server did not return idle: ${JSON.stringify(health)}`);
  }
  evidence.push("idle");
  assertLifecycleEvidence(evidence, [
    "request", "tool_call", "tool_result", "subagent_request", "subagent_result",
    "compact", "interrupt", "resume", "steering_active", "steering", "idle",
  ]);
  assertSingleLifecycleEvidence(evidence, "steering");
  assertSingleLifecycleEvidence(evidence, "subagent_request");
  assertSingleLifecycleEvidence(evidence, "subagent_result");
  process.stdout.write(`CLAUDE_DETERMINISTIC_LIFECYCLE_OK ${JSON.stringify(evidence)}\n`);
} finally {
  await server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
