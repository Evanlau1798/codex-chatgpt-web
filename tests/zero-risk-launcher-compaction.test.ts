import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import {
  createChatGptWebAdapter,
  type ChatGptZeroRiskManualControl,
} from "../src/adapters/chatgpt-web/index";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import { defaultBrokerEndpoint } from "../src/config";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const testTempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
const root = mkdtempSync(join(testTempRoot, "cgw-zero-risk-adapter-"));
afterAll(() => {
  chatGptTurnSessions.clear();
  rmSync(root, { recursive: true, force: true });
});

function request(turnId: string): CodexParsedRequest {
  const threadId = "thread_safe_adapter";
  const environment = `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`;
  return {
    modelId: CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL,
    stream: true,
    options: { reasoning: "low" },
    context: {
      tools: [],
      messages: [
        { role: "developer", content: environment, timestamp: 1 },
        { role: "user", content: "Inspect the Zero Risk transport.", timestamp: 2 },
      ],
    },
    _rawBody: {
      prompt_cache_key: threadId,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
      },
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: environment }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Inspect the Zero Risk transport." }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      ],
    },
  };
}

function binding(prompt: string): { request_id: string } {
  const match = prompt.match(/<codex_zero_risk_request_json>\n(\{[^\n]+\})\n<\/codex_zero_risk_request_json>/);
  if (!match) throw new Error("Zero Risk prompt did not expose its request id");
  return JSON.parse(match[1]!) as { request_id: string };
}

function provider(name: string): CodexProviderConfig {
  return {
    adapter: "chatgpt-web",
    baseUrl: `manual://${name}-${Date.now()}`,
    chatgptWeb: {
      appName: "Codex Zero Risk",
      browserInteractionMode: "manual",
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, `${name}-launcher.json`),
      brokerSocketPath: defaultBrokerEndpoint(join(root, name)),
      localToolsEnabled: true,
      solAvailable: false,
      proAvailable: false,
      experimentalBiggerContext: false,
    },
  };
}

function noManualTerminal(): Promise<never> {
  return new Promise<never>(() => {});
}

for (const scenario of [
  { format: "v1", finalWins: false },
  { format: "v2", finalWins: false },
  { format: "v2", finalWins: true },
] as const) test(`Zero Risk ${scenario.format} compaction resumes with exact launcher ownership (final wins: ${scenario.finalWins})`, async () => {
  // Fork manual compaction retires an active source and opens an independent checkpoint;
  // canonical tool results are never rewritten with handoff instructions. Real launcher
  // tombstones still prevent reuse, and an already completed source must replay its final.
  const require = createRequire(import.meta.url);
  const { BrowserHost } = require("../launcher/electron/browser-host.cjs");
  const { BrowserControlServer } = require("../launcher/electron/control-server.cjs");
  const config = provider(`compaction-owner-${scenario.format}-${scenario.finalWins}`);
  const socket = config.chatgptWeb!.brokerSocketPath!;
  const broker = TurnBroker.forSocket(socket);
  const logs: string[] = [];
  const logger = { info(event: string) { logs.push(event); }, warn() {}, error() {} };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map(), manualTerminalSignals: new Map(), manualCompletionSignals: new Map(),
    manualOperation: null, clipboard: { writeText() {} }, logger,
    publishState() {}, snapshot: () => ({}), showWindow() {}, show() {}, writeDescriptor() {},
    createManualTurnTab(traceId: string, helperPid: number, conversationKey: string | undefined,
      prompt: string, manualSubmitTimeoutMs: number) {
      const tab = {
        id: traceId, traceId, helperPid, conversationKey, interactionMode: "manual", status: "running",
        manualState: "awaiting-user", manualSubmitTimeoutMs, manualDeadlineAt: Date.now() + manualSubmitTimeoutMs,
        manualDeadlineTimer: null, manualWaiters: new Set(), manualTerminalWaiters: new Set(),
        prompt, promptDigest: createHash("sha256").update(prompt).digest("hex"), manualConversationReused: false,
      };
      host.turnTabs.set(tab.id, tab);
      return tab;
    },
    removeTurnTab(tab: { id: string; manualTimer?: ReturnType<typeof setTimeout> }) {
      clearTimeout(tab.manualTimer);
      host.turnTabs.delete(tab.id);
    },
  });
  const { ManualTurnController } = require("../launcher/electron/manual-turn-controller.cjs");
  host.manualTurns = new ManualTurnController({ clipboard: host.clipboard, host, logger });
  host.presentManualTurn = () => {};
  const server = await new BrowserControlServer({
    logger, getBrowserHost: () => host, getPreferences: () => ({}),
  }).start();
  writeFileSync(config.chatgptWeb!.browserHostDescriptorPath!, JSON.stringify({
    version: 2, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "development", pid: process.pid,
    endpoint: server.descriptor().endpoint, control: server.descriptor(),
    helper: { executable: process.execPath, script: import.meta.path },
    partition: "persist:codex-web-gpt-dev-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB", createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  const starts: string[] = [];
  const compactionFlags: Array<true | undefined> = [];
  const bindings = new Map<string, string>();
  let modelAction: Promise<void> | undefined;
  let sourceCancelled = false;
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) {
      host.beginManualTurn(activity.traceId, activity.helperPid, activity.prompt,
        activity.conversationKey, activity.resumePrompt, activity.compaction);
      starts.push(activity.traceId);
      compactionFlags.push(activity.compaction);
      bindings.set(activity.traceId, binding(activity.prompt).request_id);
    },
    async waitSent(_path, owner) {
      host.confirmManualSent(owner.traceId);
    },
    async waitTerminal(_path, owner) {
      broker.startSafeTurn(bindings.get(owner.traceId)!);
      return noManualTerminal();
    },
    async markStarted(_path, owner) {
      host.markManualTurnStarted(owner.traceId, owner.helperPid);
      const token = bindings.get(owner.traceId)!;
      if (starts.length > 1) {
        broker.completeSafeTurn(token, "Final answer after compaction");
        return;
      }
      modelAction = (async () => {
        const claim = await callTurnBroker<{ bindingId: string; activityId: string }>(socket, {
          method: "claim", token, contract: "safe",
        });
        const result = await callTurnBroker<BrokerToolResult>(socket, {
          method: "invoke", bindingId: claim.bindingId, wireName: "exec_command", freeform: false,
          arguments: { cmd: "pwd" },
        }, null);
        expect(JSON.stringify(result)).not.toContain("codex_turn_complete");
        await callTurnBroker(socket, { method: "activity_complete", token, activityId: claim.activityId });
        broker.completeSafeTurn(token, scenario.finalWins
          ? "Ordinary final answer before compaction"
          : "Checkpoint: the command finished; continue the task.");
      })().catch(error => {
        if (scenario.finalWins) throw error;
        expect(error.message).toContain("revoked");
        sourceCancelled = true;
      });
    },
    async end(_path, activity) {
      return host.endManualTurn(activity.traceId, activity.helperPid, activity.status, activity.retain);
    },
    async cancel(_path, owner) { host.cancelManualTurn(owner.traceId, owner.helperPid); },
  };
  const adapter = createChatGptWebAdapter(config, { broker, zeroRiskManualControl: control });
  const source = request("turn_safe_active_compaction");
  source.context.tools = [{ name: "exec_command", description: "Run a command", parameters: { type: "object" } }];
  const events: AdapterEvent[] = [];
  try {
    await adapter.runTurn!(source, { headers: new Headers() }, event => events.push(event));
    const call = events.find(event => event.type === "tool_call_start");
    if (call?.type !== "tool_call_start") throw new Error("Source did not emit its native tool call");
    const compact = structuredClone(source);
    compact.context.messages.push({
      role: "toolResult", toolCallId: call.id, toolName: "exec_command", content: root, isError: false, timestamp: 3,
    });
    (compact._rawBody as { input: unknown[] }).input.push({
      type: "function_call_output", call_id: call.id, output: root,
    });
    if (scenario.finalWins) {
      // Let the ordinary result finish before native Codex requests compaction. Its final answer
      // must survive retirement even though a fresh manual checkpoint uses another browser owner.
      await adapter.runTurn!(compact, { headers: new Headers() }, () => {});
    }
    compact._compactionRequest = true;
    const checkpoint: AdapterEvent[] = [];
    await adapter.runTurn!(compact, { headers: new Headers() }, event => checkpoint.push(event));
    await modelAction;
    expect(checkpoint.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(sourceCancelled).toBe(!scenario.finalWins);
    expect(host.manualTurns.completions.has(starts[0])).toBe(scenario.finalWins);
    const summary = checkpoint.filter(event => event.type === "text_delta").map(event => event.text).join("");
    const continuation = structuredClone(source);
    (continuation._rawBody as { input: unknown[] }).input.push(scenario.format === "v2" ? {
      type: "compaction", encrypted_content: encodeCompactionSummary(summary),
    } : {
      type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${summary}` }],
    });
    const final: AdapterEvent[] = [];
    await adapter.runTurn!(continuation, { headers: new Headers() }, event => final.push(event));
    expect(starts).toHaveLength(scenario.finalWins ? 2 : 3);
    expect(new Set(starts).size).toBe(starts.length);
    expect(compactionFlags).toEqual(scenario.finalWins ? [undefined, true] : [undefined, true, undefined]);
    const expectedFinal = scenario.finalWins ? "Ordinary final answer before compaction" : "Final answer after compaction";
    expect(final.some(event => event.type === "text_delta" && event.text === expectedFinal)).toBeTrue();
    const replay: AdapterEvent[] = [];
    await adapter.runTurn!(continuation, { headers: new Headers() }, event => replay.push(event));
    expect(starts).toHaveLength(scenario.finalWins ? 2 : 3); // exact reconnect replays, it must not submit again
    expect(replay.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(() => host.beginManualTurn(starts[0], process.pid, "old prompt")).toThrow("already");
  } finally {
    chatGptTurnSessions.clear();
    for (const tab of host.turnTabs.values()) clearTimeout(tab.manualTimer);
    await broker.close();
    await server.close();
  }
});
