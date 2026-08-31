import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { callTurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultBrokerEndpoint, defaultConfig } from "../src/config";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import { startServer } from "../src/server";

const jsonHeaders = { "content-type": "application/json" };

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
  const server = startServer(config, {
    adapterFactory: provider => createChatGptWebAdapter({
      ...provider,
      chatgptWeb: {
        ...provider.chatgptWeb,
        threadEnvironmentStatePath: join(root, "thread-environments.json"),
        lunaCheckpointStatePath: join(root, "luna-checkpoints.json"),
      },
    }, { worker }),
  });
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
