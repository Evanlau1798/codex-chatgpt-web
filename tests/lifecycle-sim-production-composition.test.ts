import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import type { ChatGptRuntimeWorker } from "../src/adapters/chatgpt-web/adapter-runtime-factory";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { callTurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultBrokerEndpoint, defaultConfig } from "../src/config";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import { startServer } from "../src/server";

const jsonHeaders = { "content-type": "application/json" };

type SseCapture = {
  events: Array<Record<string, unknown>>;
  doneCount: number;
  completed: Record<string, unknown>;
};

async function captureSse(response: Response): Promise<SseCapture> {
  expect(response.status).toBe(200);
  const payloads = (await response.text()).split(/\r?\n/)
    .filter(line => line.startsWith("data: "))
    .map(line => line.slice(6));
  const doneCount = payloads.filter(payload => payload === "[DONE]").length;
  const events = payloads.filter(payload => payload !== "[DONE]")
    .map(payload => JSON.parse(payload) as Record<string, unknown>);
  const completedIndexes = events.flatMap((event, index) => event.type === "response.completed" ? [index] : []);
  expect(completedIndexes).toHaveLength(1);
  expect(doneCount).toBe(1);
  expect(payloads.at(-1)).toBe("[DONE]");
  expect(events.slice(completedIndexes[0]! + 1)).toHaveLength(0);
  return { events, doneCount, completed: events[completedIndexes[0]!]! };
}

function completedItems(capture: SseCapture): Array<Record<string, unknown>> {
  const response = capture.completed.response as Record<string, unknown>;
  return response.output as Array<Record<string, unknown>>;
}

function terminalItems(capture: SseCapture, type: string): Array<Record<string, unknown>> {
  return capture.events.flatMap(event => (
    event.type === "response.output_item.done"
      && (event.item as Record<string, unknown> | undefined)?.type === type
      ? [event.item as Record<string, unknown>]
      : []
  ));
}

function startProductionServer(
  config: ReturnType<typeof defaultConfig>,
  root: string,
  worker: ChatGptRuntimeWorker,
) {
  return startServer(config, {
    adapterFactory: provider => createChatGptWebAdapter({
      ...provider,
      chatgptWeb: {
        ...provider.chatgptWeb,
        threadEnvironmentStatePath: join(root, "thread-environments.json"),
        lunaCheckpointStatePath: join(root, "luna-checkpoints.json"),
      },
    }, { worker }),
  });
}

test("the deterministic lane composes production routing, adapter, broker, compact, and cancellation", async () => {
  const root = join(tmpdir(), `cgw-production-lifecycle-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const config = defaultConfig("full");
  config.port = 0;
  config.proAvailable = true;
  config.useEnhancedWebSessionMode = false;
  config.brokerSocketPath = defaultBrokerEndpoint(root);
  let cancellationStarted!: () => void;
  const cancellationReady = new Promise<void>(resolve => { cancellationStarted = resolve; });
  const tokens: string[] = [];
  const worker = {
    async run(turn: BrowserTurn): Promise<string> {
      const prepared = await turn.prepare();
      try {
        turn.onSendActivated?.();
        turn.onSubmitted?.();
        if (prepared.text.includes("PRODUCTION_COMPOSITION_CANCEL")) {
          cancellationStarted();
          await new Promise<void>((_resolve, reject) => {
            const fail = () => reject(turn.abortSignal?.reason ?? new DOMException("aborted", "AbortError"));
            if (turn.abortSignal?.aborted) fail();
            else turn.abortSignal?.addEventListener("abort", fail, { once: true });
          });
        }
        if (turn.compaction) {
          const answer = "Deterministic production compact summary.";
          turn.onTextDelta(answer);
          return answer;
        }
        const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
        if (!token) throw new Error("Production-composed tool turn has no broker token");
        tokens.push(token);
        const claimed = await callTurnBroker<{ bindingId: string }>(
          config.brokerSocketPath,
          { method: "claim", token },
        );
        const result = await callTurnBroker<BrokerToolResult>(config.brokerSocketPath, {
          method: "invoke",
          bindingId: claimed.bindingId,
          wireName: "exec_command",
          freeform: false,
          arguments: { cmd: "echo production-composed" },
        }, 10_000);
        expect(result.isError).not.toBe(true);
        const answer = "PRODUCTION_COMPOSITION_OK";
        turn.onTextDelta(answer);
        return answer;
      } finally {
        prepared.release();
      }
    },
    requestPreemptiveRetry: () => false,
  };
  const server = startProductionServer(config, root, worker);
  const endpoint = `http://127.0.0.1:${server.port}`;
  const environment = `<environment_context><cwd>${root}</cwd><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></environment_context>`;
  const metadata = { "x-codex-turn-metadata": JSON.stringify({ thread_id: "production-thread", turn_id: "production-turn" }) };
  const initialInput = [
    { type: "message", role: "user", content: [{ type: "input_text", text: environment }], internal_chat_message_metadata_passthrough: { turn_id: "production-turn" } },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Run PRODUCTION_COMPOSITION_TOOL." }], internal_chat_message_metadata_passthrough: { turn_id: "production-turn" } },
  ];
  const requestBody = {
    model: "chatgpt-web/high",
    input: initialInput,
    tools: [{ type: "function", name: "exec_command", description: "Run a command", parameters: { type: "object" } }],
    prompt_cache_key: "production-thread",
    client_metadata: metadata,
  };
  const post = (path: string, body: unknown, signal?: AbortSignal) => fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  try {
    const first = await post("/v1/responses", requestBody);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { output?: Array<Record<string, unknown>> };
    const call = firstBody.output?.find(item => item.type === "function_call");
    expect(call).toMatchObject({ type: "function_call", name: "exec_command" });

    const second = await post("/v1/responses", {
      ...requestBody,
      input: [...initialInput, call, {
        type: "function_call_output",
        call_id: call?.call_id,
        output: JSON.stringify({ output: "production-composed", exit_code: 0 }),
      }],
    });
    expect(second.status).toBe(200);
    expect(JSON.stringify(await second.json())).toContain("PRODUCTION_COMPOSITION_OK");
    await expect(callTurnBroker(config.brokerSocketPath, { method: "claim", token: tokens[0] }))
      .rejects.toThrow(/finished|retired|invalid|expired/i);

    const compact = await post("/v1/responses/compact", {
      model: "chatgpt-web/high",
      prompt_cache_key: "compact-thread",
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "compact-thread", turn_id: "compact-turn" }) },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Compact production composition." }],
        internal_chat_message_metadata_passthrough: { turn_id: "compact-turn" },
      }],
    });
    const compactBody = await compact.text();
    if (compact.status !== 200) throw new Error(`Production compact failed: HTTP ${compact.status} ${compactBody}`);
    expect(compactBody).toContain(`${SUMMARY_PREFIX}\\nDeterministic production compact summary.`);

    const controller = new AbortController();
    const cancelled = post("/v1/responses", {
      ...requestBody,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: environment }], internal_chat_message_metadata_passthrough: { turn_id: "cancel-turn" } },
        { type: "message", role: "user", content: [{ type: "input_text", text: "PRODUCTION_COMPOSITION_CANCEL" }], internal_chat_message_metadata_passthrough: { turn_id: "cancel-turn" } },
      ],
      prompt_cache_key: "cancel-thread",
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "cancel-thread", turn_id: "cancel-turn" }) },
    }, controller.signal).catch(error => error);
    await cancellationReady;
    controller.abort();
    await cancelled;
    for (let attempt = 0; attempt < 50 && chatGptTurnSessions.activeCount() > 0; attempt += 1) await Bun.sleep(10);
    const health = await fetch(`${endpoint}/healthz`).then(response => response.json()) as Record<string, unknown>;
    expect(health).toMatchObject({ active_http_turns: 0, active_browser_turns: 0 });
    expect(chatGptTurnSessions.activeCount()).toBe(0);
  } finally {
    chatGptTurnSessions.clear();
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("Enhanced streaming retains one production surface and fully cleans an aborted continuation", async () => {
  const root = join(tmpdir(), `cgw-production-enhanced-stream-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const config = defaultConfig("full");
  config.port = 0;
  config.proAvailable = true;
  config.useEnhancedWebSessionMode = true;
  config.brokerSocketPath = defaultBrokerEndpoint(root);
  const turns: Array<Pick<BrowserTurn, "retainConversation" | "conversationKey">> = [];
  const surfaces = new Set<string>();
  const tokens: string[] = [];
  let cancellationStarted!: () => void;
  const cancellationReady = new Promise<void>(resolve => { cancellationStarted = resolve; });
  const worker = {
    async run(turn: BrowserTurn): Promise<string> {
      turns.push({ retainConversation: turn.retainConversation, conversationKey: turn.conversationKey });
      if (!turn.conversationKey) throw new Error("Enhanced turn has no conversation key");
      surfaces.add(turn.conversationKey);
      const prepared = await turn.prepare();
      try {
        turn.onSendActivated?.();
        turn.onSubmitted?.();
        if (prepared.text.includes("ENHANCED_STREAM_CANCEL")) {
          cancellationStarted();
          await new Promise<void>((_resolve, reject) => {
            const fail = () => reject(turn.abortSignal?.reason ?? new DOMException("aborted", "AbortError"));
            if (turn.abortSignal?.aborted) fail();
            else turn.abortSignal?.addEventListener("abort", fail, { once: true });
          });
        }
        const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
        if (!token) throw new Error("Enhanced streaming tool turn has no broker token");
        tokens.push(token);
        const claimed = await callTurnBroker<{ bindingId: string }>(
          config.brokerSocketPath,
          { method: "claim", token },
        );
        const result = await callTurnBroker<BrokerToolResult>(config.brokerSocketPath, {
          method: "invoke",
          bindingId: claimed.bindingId,
          wireName: "exec_command",
          freeform: false,
          arguments: { cmd: "echo enhanced-stream" },
        }, 10_000);
        expect(result.isError).not.toBe(true);
        const answer = "ENHANCED_STREAM_OK";
        turn.onTextDelta(answer);
        return answer;
      } finally {
        prepared.release();
      }
    },
    requestPreemptiveRetry: () => false,
  };
  const server = startProductionServer(config, root, worker);
  const endpoint = `http://127.0.0.1:${server.port}`;
  const environment = `<environment_context><cwd>${root}</cwd><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></environment_context>`;
  const message = (text: string, turnId: string, role = "user") => ({
    type: "message",
    role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });
  const initialInput = [message(environment, "enhanced-turn"), message("Run ENHANCED_STREAM_TOOL.", "enhanced-turn")];
  const requestBody = {
    model: "chatgpt-web/high",
    stream: true,
    input: initialInput,
    tools: [{ type: "function", name: "exec_command", description: "Run a command", parameters: { type: "object" } }],
    prompt_cache_key: "enhanced-thread",
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "enhanced-thread", turn_id: "enhanced-turn" }) },
  };
  const post = (body: unknown, signal?: AbortSignal) => fetch(`${endpoint}/v1/responses`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  try {
    const first = await captureSse(await post(requestBody));
    const firstCalls = completedItems(first).filter(item => item.type === "function_call");
    expect(firstCalls).toHaveLength(1);
    expect(terminalItems(first, "function_call")).toHaveLength(1);
    const call = firstCalls[0]!;

    const second = await captureSse(await post({
      ...requestBody,
      input: [...initialInput, call, {
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify({ output: "enhanced-stream", exit_code: 0 }),
      }],
    }));
    expect(completedItems(second).filter(item => item.type === "message")).toHaveLength(1);
    expect(terminalItems(second, "message")).toHaveLength(1);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ retainConversation: true });
    expect(turns[0]!.conversationKey).toMatch(/^[a-f0-9]{64}$/);
    expect(surfaces.size).toBe(1);
    await expect(callTurnBroker(config.brokerSocketPath, { method: "claim", token: tokens[0] }))
      .rejects.toThrow(/finished|retired|invalid|expired/i);

    const cancelTurnId = "enhanced-cancel";
    const cancelInput = [
      ...initialInput,
      call,
      { type: "function_call_output", call_id: call.call_id, output: "enhanced-stream" },
      message("ENHANCED_STREAM_OK", "enhanced-turn", "assistant"),
      message("ENHANCED_STREAM_CANCEL", cancelTurnId),
    ];
    const controller = new AbortController();
    const cancelled = post({
      ...requestBody,
      input: cancelInput,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "enhanced-thread", turn_id: cancelTurnId }) },
    }, controller.signal).then(response => response.text()).catch(error => error);
    await cancellationReady;
    controller.abort();
    await cancelled;
    for (let attempt = 0; attempt < 50 && chatGptTurnSessions.activeCount() > 0; attempt += 1) await Bun.sleep(10);
    const health = await fetch(`${endpoint}/healthz`).then(response => response.json()) as Record<string, unknown>;
    expect(turns.at(-1)?.conversationKey).toBe(turns[0]!.conversationKey);
    expect(surfaces.size).toBe(1);
    expect(health).toMatchObject({ active_http_turns: 0, active_browser_turns: 0 });
    expect(chatGptTurnSessions.activeCount()).toBe(0);
  } finally {
    chatGptTurnSessions.clear();
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
