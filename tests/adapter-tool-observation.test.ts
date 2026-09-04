import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { deferred } from "../src/adapters/chatgpt-web/runtime-lifecycle";
import { defaultBrokerEndpoint } from "../src/config";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

for (const outcome of ["failure", "abort", "late-observation"] as const) {
  test(`Automatic tool observation preserves ${outcome} without a second fixed deadline`, async () => {
    const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-tool-observe-"));
    const socket = defaultBrokerEndpoint(root);
    const broker = TurnBroker.forSocket(socket);
    const environment = `<environment_context><cwd>${root}</cwd><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></environment_context>`;
    const input: CodexParsedRequest = {
      modelId: CHATGPT_WEB_MODEL_ID, stream: true, options: { reasoning: "high" },
      context: {
        tools: [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }],
        messages: [{ role: "user", content: environment, timestamp: 1 }, { role: "user", content: "Inspect the project", timestamp: 2 }],
      },
      _rawBody: {
        prompt_cache_key: root,
        client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: root, turn_id: outcome }) },
        input: [environment, "Inspect the project"].map(text => ({
          type: "message", role: "user", content: [{ type: "input_text", text }],
          internal_chat_message_metadata_passthrough: { turn_id: outcome },
        })),
      },
    };
    const ready = deferred<void>();
    const settle = deferred<string>();
    const controller = new AbortController();
    let turn!: BrowserTurn;
    let invocation: Promise<unknown> | undefined;
    const worker = {
      async run(value: BrowserTurn) {
        turn = value;
        const prepared = await turn.prepare();
        try {
          const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)![1]!;
          const { bindingId } = await callTurnBroker<{ bindingId: string }>(socket, { method: "claim", token });
          invocation = callTurnBroker(socket, {
            method: "invoke", bindingId, wireName: "exec_command", freeform: false, arguments: { cmd: "pwd" },
          }, null).catch(error => error);
          const progress = turn.externalProgress!;
          while (!progress.snapshot().lastToolBatchRevision) {
            await progress.waitForChange(progress.snapshot().revision, turn.abortSignal);
          }
          ready.resolve();
          return await settle.promise;
        } finally { prepared.release(); }
      },
    };
    const events: AdapterEvent[] = [];
    const running = createChatGptWebAdapter({
      adapter: "chatgpt-web", baseUrl: `browser://${root}`,
      chatgptWeb: { brokerSocketPath: socket, localToolsEnabled: true },
    }, { broker, worker }).runTurn!(input, { headers: new Headers(), abortSignal: controller.signal }, event => events.push(event));
    const result = running.then(() => ({ ok: true }), error => ({ error }));
    try {
      await ready.promise;
      expect(events.some(event => event.type === "tool_call_start")).toBe(false);
      if (outcome === "late-observation") {
        // The owned browser deadline is longer than the obsolete ten-second observer timer.
        await Bun.sleep(10_050);
        expect(events.some(event => event.type === "tool_call_start")).toBe(false);
        turn.onTextDelta("Commentary captured at the tool boundary.");
        await turn.externalProgress!.acknowledgeToolBatch(turn.externalProgress!.snapshot().lastToolBatchRevision);
        expect(await result).toEqual({ ok: true });
        expect(events.filter(event => event.type === "tool_call_start")).toHaveLength(1);
        const replay: AdapterEvent[] = [];
        await createChatGptWebAdapter({
          adapter: "chatgpt-web", baseUrl: `browser://${root}`,
          chatgptWeb: { brokerSocketPath: socket, localToolsEnabled: true },
        }, { broker, worker }).runTurn!(input, { headers: new Headers() }, event => replay.push(event));
        expect(replay.filter(event => event.type === "text_delta"))
          .toEqual(events.filter(event => event.type === "text_delta"));
      } else {
        if (outcome === "failure") settle.reject(new Error("owned browser observation failed"));
        else controller.abort();
        const observed = await Promise.race([result, Bun.sleep(500).then(() => "still waiting")]);
        expect(observed).not.toBe("still waiting");
        expect(observed).toMatchObject({ error: outcome === "abort"
          ? { name: "AbortError" } : { message: "owned browser observation failed" } });
        expect(events.some(event => event.type === "tool_call_start")).toBe(false);
      }
    } finally {
      controller.abort();
      settle.resolve("closed");
      chatGptTurnSessions.clear();
      await broker.close();
      await result;
      await invocation;
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
}
