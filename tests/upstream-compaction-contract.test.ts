import { expect, spyOn, test } from 'bun:test';
import { mock } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { chatGptConversationKey } from '../src/adapters/chatgpt-web/conversation-key';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ChatGptBrowserWorker, type BrowserTurn } from '../src/adapters/chatgpt-web/browser-worker';
import { chatGptSuspensionClock } from '../src/adapters/chatgpt-web/browser-stage-lifecycle';
import { ChatGptWebAdapterError } from '../src/adapters/chatgpt-web/adapter-error';
import { requestRetainedCompactionHandoff } from '../src/adapters/chatgpt-web/retained-compaction-handoff';
import { runStructuredCompactionOnce } from '../src/adapters/chatgpt-web/compaction-handoff';
import { CompactionTransactionStore } from '../src/adapters/chatgpt-web/compaction-transaction';
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession } from '../src/adapters/chatgpt-web/turn-execution';
import { createChatGptWebAdapter } from '../src/adapters/chatgpt-web/index';
import { chatGptWebExecutionNamespace } from '../src/adapters/chatgpt-web/index';
import { chatGptTurnExecutionKey, chatGptTurnSessions } from '../src/adapters/chatgpt-web/turn-execution';
import { TurnBroker, callTurnBroker } from '../src/adapters/chatgpt-web/turn-broker';
import { defaultBrokerEndpoint } from '../src/config';
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from '../src/types';
function shortSocketTempRoot(): string {
  return process.platform === "win32" ? tmpdir() : "/tmp";
}

test("an Enhanced size rejection stays cached after its physical owner settles", async () => {
  const key = `oversize-receipt-${crypto.randomUUID()}`;
  let starts = 0;
  const failure = new ChatGptWebAdapterError("size limit", {
    status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false,
  });
  const run = runStructuredCompactionOnce(key, async () => { starts++; throw failure; });
  await expect(run).rejects.toBe(failure);
  await Bun.sleep(0);
  const replay = runStructuredCompactionOnce(key, async () => { starts++; return "must not upload"; });
  expect(replay).toBe(run);
  await expect(replay).rejects.toBe(failure);
  expect(starts).toBe(1);
});

test("Original compact timeout retains physical ownership until the browser actually settles", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-original-physical-"));
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: `browser://physical-${root}`,
    chatgptWeb: { browserHost: "launcher", browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root), localToolsEnabled: true, solAvailable: true,
      proAvailable: true, turnTimeoutMs: 40 } };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let finish!: (text: string) => void;
  const physical = new Promise<string>(resolve => { finish = resolve; });
  worker.run = async turn => {
    turn.onSubmitted?.(); started();
    const answer = await physical;
    turn.onTextDelta(answer);
    return answer;
  };
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const clockNow = spyOn(performance, "now").mockImplementation(() => Date.now());
  const parsed = request(true);
  const key = `${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(parsed)}`;
  const events: AdapterEvent[] = [];
  const run = createChatGptWebAdapter(provider).runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
  try {
    await ready;
    mock.timers.tick(41);
    await run;
    expect(events.at(-1)).toMatchObject({ type: "error", code: "compaction_handoff_timeout" });
    const owner = chatGptTurnSessions.find(key)!;
    expect(owner).toBeDefined();
    let settled = false;
    void owner.physicalSettlement.then(() => { settled = true; });
    await Bun.sleep(0);
    expect(settled).toBeFalse();
    finish("browser cleanup");
    await owner.physicalSettlement;
    expect(settled).toBeTrue();
  } finally {
    finish("cleanup");
    await run;
    await chatGptTurnSessions.retireAndWait(key);
    clockNow.mockRestore(); mock.timers.reset(); worker.run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  { enhanced: true, activity: "silent" },
  { enhanced: true, activity: "generation" },
  { enhanced: false, activity: "generation" },
  { enhanced: true, activity: "heartbeat" },
  { enhanced: true, activity: "content" },
])("browser compaction bounds $activity inactivity and retains ownership (Enhanced=$enhanced)", async ({ enhanced, activity }) => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-local-physical-"));
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: `browser://local-${root}`,
    chatgptWeb: { browserHost: "launcher", browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root), localToolsEnabled: true, solAvailable: true,
      proAvailable: true, useEnhancedWebSessionMode: enhanced } };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let finish!: (text: string) => void;
  const physical = new Promise<string>(resolve => { finish = resolve; });
  let running!: BrowserTurn;
  worker.run = async turn => {
    running = turn;
    turn.onSubmitted?.(); started();
    const answer = await physical;
    turn.onTextDelta(answer);
    return answer;
  };
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const clockNow = spyOn(performance, "now").mockImplementation(() => Date.now());
  const parsed = { ...request(!enhanced), _localCompactionRequest: enhanced };
  const key = `${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(parsed)}`;
  const events: AdapterEvent[] = [];
  const run = createChatGptWebAdapter(provider).runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
  try {
    await ready;
    for (let second = 0; second < 301; second++) {
      if (second % 10 === 0) {
        if (activity === "generation") running.onGenerationProgress?.();
        if (activity === "heartbeat") running.onHeartbeat?.();
        if (activity === "content") running.onProgress?.();
      }
      mock.timers.tick(1_000);
      chatGptSuspensionClock.tick(performance.now());
    }
    await Bun.sleep(0);
    if (activity === "content") expect(events.some(event => event.type === "error")).toBeFalse();
    else expect(events.at(-1)).toMatchObject({ type: "error", code: "compaction_handoff_timeout" });
    const owner = chatGptTurnSessions.find(key)!;
    expect(owner).toBeDefined();
    let settled = false;
    void owner.physicalSettlement.then(() => { settled = true; });
    await Bun.sleep(0);
    expect(settled).toBeFalse();
    finish("browser cleanup");
    await owner.physicalSettlement;
    expect(settled).toBeTrue();
  } finally {
    finish("cleanup");
    await run;
    await chatGptTurnSessions.retireAndWait(key);
    clockNow.mockRestore(); mock.timers.reset(); worker.run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

function request(compaction = false): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    context: {
      messages: [
        { role: "user", content: "Original task", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Work completed" }], timestamp: 2 },
        { role: "user", content: "Continue with the next step", timestamp: 3 },
      ],
    },
    options: { reasoning: "high" },
    _compactionRequest: compaction,
    _rawBody: {
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue with the next step" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_source" },
      }],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_retained_compaction",
          turn_id: compaction ? "turn_compact" : "turn_source",
        }),
      },
    },
  };
}

function controlBinding(instruction: string): { token: string; handoffId: string } {
  const token = instruction.match(/turn_token (turn_[a-f0-9]{32})/)?.[1];
  const handoffId = instruction.match(/handoff_id (handoff_[a-f0-9]{32})/)?.[1];
  if (!token || !handoffId) throw new Error(`Missing compaction control binding: ${instruction}`);
  return { token, handoffId };
}

test("retained compaction submits through the published MCP contract with no ordinary tool authority", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-compaction-mcp-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const client = new Client({ name: "compaction-contract-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--broker-socket", broker.socketPath],
    cwd: resolve(import.meta.dir, ".."), stderr: "pipe",
  });
  const sourceRequest = request(false);
  const source = new ChatGptTurnSession({
    mode: "read-only", browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(), trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    usageInput: sourceRequest, conversationKey: chatGptConversationKey(sourceRequest, "provider")!, cancel() {},
  });
  try {
    await client.connect(transport);
    const run = async (turn: BrowserTurn) => {
      const prepared = await turn.prepare();
      try {
        const { token, handoffId } = controlBinding(prepared.text);
        const result = await client.callTool({ name: "codex_tool_call", arguments: {
          turn_token: token, wire_name: "codex.control.compaction_handoff",
          arguments: { handoff_id: handoffId, summary: "Complete checkpoint sent through MCP" },
        } });
        if (result.isError) throw new Error(JSON.stringify(result.content));
        return "Checkpoint submitted.";
      } finally { prepared.release(); }
    };
    const summary = await requestRetainedCompactionHandoff(
      { appName: "Codex app", run } as never, request(true), source, broker,
      { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      "trace_mcp_handoff",
    );
    expect(summary).toBe("Complete checkpoint sent through MCP");

    const transaction = await broker.beginCompactionTransaction("trace_mcp_boundaries", 30_000);
    for (const [name, args] of [
      ["codex_exec", { cmd: "echo must-not-run" }],
      ["codex_tool_inventory", {}],
      ["codex_tool_call", { wire_name: "exec_command", arguments: { cmd: "echo must-not-run" } }],
    ] as const) {
      const denied = await client.callTool({ name, arguments: { turn_token: transaction.token, ...args } });
      expect(denied.isError).toBeTrue();
      expect(JSON.stringify(denied.content)).toContain("turn token is invalid");
    }
    const submit = (token: string, handoffId: string) => client.callTool({ name: "codex_tool_call", arguments: {
      turn_token: token, wire_name: "codex.control.compaction_handoff",
      arguments: { handoff_id: handoffId, summary: "Bound checkpoint" },
    } });
    const wrong = await submit(transaction.token, "handoff_wrong");
    expect(wrong.isError).toBeTrue();
    expect(JSON.stringify(wrong.content)).toContain("does not match");
    const ordinary = await broker.register({ cwd: root, roots: [root], writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" }, tools: [] }, 30_000);
    expect((await submit(ordinary, transaction.handoffId)).isError).toBeTrue();
    expect((await submit(transaction.token, transaction.handoffId)).isError).not.toBeTrue();
    expect(await broker.waitForCompactionHandoff(transaction.token)).toBe("Bound checkpoint");
    expect((await submit(transaction.token, transaction.handoffId)).isError).toBeTrue();
    const aborted = await broker.beginCompactionTransaction("trace_mcp_aborted", 30_000);
    broker.abortCompactionTransaction(aborted.token);
    expect((await submit(aborted.token, aborted.handoffId)).isError).toBeTrue();
  } finally {
    await client.close();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("an exact oversized compaction replays its size error instead of uploading the same parts again", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-size-compact-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://oversized-${crypto.randomUUID()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      proAvailable: true,
      experimentalBiggerContext: true,
      experimentalFreshConversationPerTurn: true,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run;
  let browserStarts = 0;
  worker.run = async turn => {
    browserStarts++;
    const prepared = await turn.prepare();
    prepared.release();
    throw new ChatGptWebAdapterError("The submitted message is too long", {
      status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false,
    });
  };
  const adapter = createChatGptWebAdapter(provider);
  const observe = async (input: CodexParsedRequest) => {
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(input, { headers: new Headers() }, event => events.push(event));
    expect(events.at(-1)).toMatchObject({
      type: "error", status: 400, code: "context_length_exceeded", retryable: false,
    });
    expect(events.some(event => event.type === "done")).toBeFalse();
  };
  try {
    await observe(request(true));
    await Bun.sleep(0);
    await observe(request(true));
    expect(browserStarts).toBe(1);

    // Changed input and model selection must reach the browser again.
    const revised = request(true);
    revised.context.messages.at(-1)!.content = "Continue";
    (revised._rawBody as { input: Array<{ content: Array<{ text: string }> }> }).input[0]!.content[0]!.text = "Continue";
    await observe(revised);
    expect(browserStarts).toBe(2);
    const otherMode = request(true);
    otherMode.options.reasoning = "max";
    await observe(otherMode);
    expect(browserStarts).toBe(3);
  } finally {
    worker.run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("compaction survives process suspension but still expires after awake inactivity", async () => {
  for (const completeAfterWake of [true, false]) {
    const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-compaction-suspension-"));
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web", baseUrl: `browser://compaction-suspension-${root}`,
      chatgptWeb: {
        browserHost: "launcher", browserHostDescriptorPath: join(root, "launcher.json"),
        brokerSocketPath: defaultBrokerEndpoint(root), localToolsEnabled: true,
        solAvailable: true, extraHighAvailable: true, proAvailable: true,
      },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let finish!: (summary: string) => void;
    const browser = new Promise<string>(resolve => { finish = resolve; });
    let signal: AbortSignal | undefined;
    let browserStarts = 0;
    worker.run = async turn => {
      browserStarts++;
      signal = turn.abortSignal;
      const settle = finish;
      finish = summary => { turn.onTextDelta(summary); settle(summary); };
      turn.onSubmitted?.();
      started();
      return browser;
    };
    const events: AdapterEvent[] = [];
    // No interval ticks run during the jump: both processes were frozen in #863.
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const time = spyOn(performance, "now").mockImplementation(() => Date.now());
    const run = createChatGptWebAdapter(provider).runTurn!(
      request(true), { headers: new Headers() }, event => events.push(event),
    );
    try {
      await ready;
      mock.timers.tick(600_000);
      await Bun.sleep(1);
      expect(signal?.aborted).toBeFalse();
      expect(events.some(event => event.type === "error")).toBeFalse();
      expect(browserStarts).toBe(1);
      if (!completeAfterWake) {
        // The process is awake again, but ChatGPT produces no activity.
        for (let i = 0; i < 300; i++) {
          chatGptSuspensionClock.tick(performance.now());
          mock.timers.tick(1_000);
        }
        await Bun.sleep(1);
        expect(signal?.aborted).toBeTrue();
        expect(events.at(-1)).toMatchObject({ type: "error", code: "compaction_handoff_timeout" });
      }
      finish("Checkpoint completed after the process resumed");
      await run;
      if (completeAfterWake) {
        expect(events.some(event => event.type === "text_delta"
          && event.text.includes("Checkpoint completed after the process resumed"))).toBeTrue();
        expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
      }
    } finally {
      finish("test cleanup");
      await run;
      time.mockRestore();
      mock.timers.reset();
      worker.run = originalRun;
      await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});
