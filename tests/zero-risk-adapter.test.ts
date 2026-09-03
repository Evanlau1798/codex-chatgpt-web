import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import {
  createChatGptWebAdapter,
  chatGptWebExecutionNamespace,
  type ChatGptZeroRiskManualControl,
} from "../src/adapters/chatgpt-web/index";
import {
  ChatGptTextFeed, ChatGptTraceFeed, chatGptCompactionSourceExecutionKey, chatGptTurnSessions,
} from "../src/adapters/chatgpt-web/turn-execution";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
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

test("a lost manual-start response still releases the possibly committed launcher turn", async () => {
  const config = provider("lost-start-response");
  const broker = TurnBroker.forSocket(config.chatgptWeb!.brokerSocketPath!);
  const ended: string[] = [];
  const control: ChatGptZeroRiskManualControl = {
    async start() { throw new Error("response lost after launcher committed the tab"); },
    async waitSent() { throw new Error("must not wait after start failed"); },
    waitTerminal: noManualTerminal,
    async markStarted() {},
    async end(_path, activity) { ended.push(activity.status); },
    async cancel() {},
  };
  try {
    await createChatGptWebAdapter(config, { broker, zeroRiskManualControl: control }).runTurn!(
      request("turn_lost_start_response"), { headers: new Headers() }, () => {},
    ).catch(() => {});
    expect(ended).toEqual(["failed"]);
  } finally {
    chatGptTurnSessions.clear();
    await broker.close();
  }
});

test("Zero Risk adapter never starts the automatic browser worker and completes only through Zero Risk MCP", async () => {
  const config = provider("complete");
  const broker = TurnBroker.forSocket(config.chatgptWeb!.brokerSocketPath!);
  const worker = ChatGptBrowserWorker.forProvider(config);
  const originalRun = worker.run.bind(worker);
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async () => {
    throw new Error("automatic browser worker must not run in Zero Risk mode");
  };
  let exactBinding: ReturnType<typeof binding> | undefined;
  const calls: string[] = [];
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) {
      calls.push("start");
      exactBinding = binding(activity.prompt);
    },
    async waitSent() {
      calls.push("sent");
      broker.startSafeTurn(exactBinding!.request_id);
    },
    waitTerminal: noManualTerminal,
    async markStarted() {
      calls.push("started");
      broker.completeSafeTurn(exactBinding!.request_id, "Zero Risk final answer");
    },
    async end(_path, activity) { calls.push(`end:${activity.status}:${activity.retain === true}`); },
    async cancel() { calls.push("cancel"); },
  };
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(config, { broker, zeroRiskManualControl: control }).runTurn!(
      request("turn_safe_complete"),
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(calls).toEqual(["start", "sent", "started", "end:completed:true"]);
    expect(events.some(event => event.type === "text_delta"
      && event.phase === "commentary"
      && event.text.startsWith("> **Action required in Zero Risk**")
      && event.text.includes("select the `Codex Zero Risk` plugin")
      && event.text.includes("confirm it was sent in the launcher"))).toBeTrue();
    expect(events.filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => (
      event.type === "text_delta" && event.phase === "final_answer"
    )).map(event => event.text).join(""))
      .toBe("Zero Risk final answer");
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await broker.close();
  }
});

test("Zero Risk keeps image handoff manual and says so in the paste instruction", async () => {
  const config = provider("image-boundary");
  const broker = TurnBroker.forSocket(config.chatgptWeb!.brokerSocketPath!);
  const input = request("turn_safe_image_boundary");
  input.context.messages[1] = {
    role: "user",
    content: [
      { type: "text", text: "Inspect this image." },
      { type: "image", imageUrl: "data:image/png;base64,AAAA" },
    ],
    timestamp: 2,
  };
  let exactBinding: ReturnType<typeof binding> | undefined;
  let manualPrompt = "";
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) {
      manualPrompt = activity.prompt;
      exactBinding = binding(activity.prompt);
    },
    async waitSent() { broker.startSafeTurn(exactBinding!.request_id); },
    waitTerminal: noManualTerminal,
    async markStarted() { broker.completeSafeTurn(exactBinding!.request_id, "Manual image handoff completed"); },
    async end() {},
    async cancel() {},
  };
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(config, { broker, zeroRiskManualControl: control }).runTurn!(
      input,
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(manualPrompt).toContain('"type":"image_attachment"');
    expect(manualPrompt).toContain("image the user manually attached to this ChatGPT message");
    expect(events.some(event => event.type === "text_delta"
      && event.phase === "commentary"
      && event.text.includes("add any images yourself because Zero Risk cannot transfer them"))).toBeTrue();
    expect(events.filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => (
      event.type === "text_delta" && event.phase === "final_answer"
    )).map(event => event.text).join(""))
      .toBe("Manual image handoff completed");
  } finally {
    chatGptTurnSessions.clear();
    await broker.close();
  }
});

test("a stopped Responses observer revokes its Zero Risk binding and releases the manual turn", async () => {
  const config = provider("stopped-observer");
  const broker = TurnBroker.forSocket(config.chatgptWeb!.brokerSocketPath!);
  let exactBinding: ReturnType<typeof binding> | undefined;
  let signalVisible!: () => void;
  const visible = new Promise<void>(resolve => { signalVisible = resolve; });
  const ended: string[] = [];
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) {
      exactBinding = binding(activity.prompt);
      signalVisible();
    },
    async waitSent(_path, _owner, options) {
      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new DOMException("manual wait aborted", "AbortError"));
        options?.abortSignal?.addEventListener("abort", abort, { once: true });
        if (options?.abortSignal?.aborted) abort();
      });
    },
    waitTerminal: noManualTerminal,
    async markStarted() {},
    async end(_path, activity) { ended.push(activity.status); },
    async cancel() {},
  };
  const adapter = createChatGptWebAdapter(config, { broker, zeroRiskManualControl: control });
  const input = request("turn_safe_stopped");
  const disconnect = new AbortController();
  try {
    const first = adapter.runTurn!(
      input,
      { headers: new Headers(), abortSignal: disconnect.signal },
      () => {},
    );
    await visible;
    disconnect.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    for (let attempt = 0; ended.length === 0 && attempt < 50; attempt += 1) await Bun.sleep(5);
    expect(ended).toEqual(["aborted"]);
    expect(() => broker.startSafeTurn(exactBinding!.request_id))
      .toThrow("invalid, expired, or revoked");
  } finally {
    chatGptTurnSessions.clear();
    await broker.close();
  }
});

test("Zero Risk offers only the new Codex suffix when the launcher reuses its retained ChatGPT chat", async () => {
  const config = provider("incremental-resume");
  const broker = TurnBroker.forSocket(config.chatgptWeb!.brokerSocketPath!);
  const input = request("turn_safe_incremental");
  input.context.messages.push(
    { role: "assistant", content: [{ type: "text", text: "Earlier answer already visible in ChatGPT." }], timestamp: 3 },
    { role: "user", content: "Continue with only this new request.", timestamp: 4 },
  );
  (input._rawBody as { input: unknown[] }).input.push(
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Earlier answer already visible in ChatGPT." }],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Continue with only this new request." }],
    },
  );
  let exactBinding: ReturnType<typeof binding> | undefined;
  let fullPrompt = "";
  let resumePrompt = "";
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) {
      fullPrompt = activity.prompt;
      resumePrompt = activity.resumePrompt ?? "";
      exactBinding = binding(resumePrompt);
    },
    async waitSent() {
      broker.startSafeTurn(exactBinding!.request_id);
    },
    waitTerminal: noManualTerminal,
    async markStarted() {
      broker.completeSafeTurn(exactBinding!.request_id, "Incremental answer");
    },
    async end() {},
    async cancel() {},
  };
  try {
    await createChatGptWebAdapter(config, { broker, zeroRiskManualControl: control }).runTurn!(
      input,
      { headers: new Headers() },
      () => {},
    );
    expect(fullPrompt).toContain("Earlier answer already visible in ChatGPT.");
    expect(fullPrompt).toContain("Continue with only this new request.");
    expect(resumePrompt).not.toContain("Earlier answer already visible in ChatGPT.");
    expect(resumePrompt).toContain("Continue with only this new request.");
  } finally {
    chatGptTurnSessions.clear();
    await broker.close();
  }
});

for (const activeSource of [false, true]) test(`Zero Risk compaction uses a fresh manual checkpoint (active source: ${activeSource})`, async () => {
  const config = provider("compaction");
  config.chatgptWeb!.useEnhancedWebSessionMode = true;
  const broker = TurnBroker.forSocket(config.chatgptWeb!.brokerSocketPath!);
  let exactBinding: ReturnType<typeof binding> | undefined;
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) { exactBinding = binding(activity.prompt); },
    async waitSent() {
      broker.startSafeTurn(exactBinding!.request_id);
    },
    waitTerminal: noManualTerminal,
    async markStarted() {
      broker.completeSafeTurn(
        exactBinding!.request_id,
        "Zero Risk checkpoint summary",
      );
    },
    async end() {},
    async cancel() {},
  };
  const input = request("turn_safe_compaction");
  input._compactionRequest = true;
  let sourceCancelled = false;
  if (activeSource) {
    let settleSource!: (answer: string) => void;
    const browser = new Promise<string>(resolve => { settleSource = resolve; });
    const sourceKey = `${chatGptWebExecutionNamespace(config)}:${chatGptCompactionSourceExecutionKey(input)}`;
    chatGptTurnSessions.getOrCreate(sourceKey, () => ({
      mode: "read-only", browser, trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
      conversationKey: "manual-source", physicalSettlement: browser.then(() => {}),
      cancel() { sourceCancelled = true; settleSource("retired"); },
    }));
  }
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(config, {
      broker, zeroRiskManualControl: control,
      worker: { run: async () => { throw new Error("manual compaction must never run an automatic worker"); } },
    }).runTurn!(
      input,
      { headers: new Headers() },
      event => events.push(event),
    );
    const deltas = events.filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => (
      event.type === "text_delta"
    ));
    expect(deltas.every(event => event.phase === "final_answer")).toBeTrue();
    expect(deltas.map(event => event.text).join(""))
      .toContain("Zero Risk checkpoint summary\n\nCODEX_LATEST_USER_PROMPT_JSON");
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
    expect(sourceCancelled).toBe(activeSource);
  } finally {
    chatGptTurnSessions.clear();
    await broker.close();
  }
});

test("closing the Zero Risk Launcher tab revokes the bound turn instead of waiting forever", async () => {
  const config = provider("cancelled-tab");
  const broker = TurnBroker.forSocket(config.chatgptWeb!.brokerSocketPath!);
  let exactBinding: ReturnType<typeof binding> | undefined;
  let releaseTerminal!: () => void;
  const terminal = new Promise<void>(resolve => { releaseTerminal = resolve; });
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) { exactBinding = binding(activity.prompt); },
    async waitSent() {
      broker.startSafeTurn(exactBinding!.request_id);
    },
    async waitTerminal() {
      await terminal;
      return { status: "cancelled" };
    },
    async markStarted() { releaseTerminal(); },
    async end() {},
    async cancel() {},
  };
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(config, { broker, zeroRiskManualControl: control }).runTurn!(
      request("turn_safe_cancelled_tab"),
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "manual_turn_cancelled",
      retryable: false,
    });
    expect(() => broker.startSafeTurn(exactBinding!.request_id))
      .toThrow("invalid, expired, or revoked");
  } finally {
    chatGptTurnSessions.clear();
    await broker.close();
  }
});
