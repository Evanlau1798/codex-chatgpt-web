import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultBrokerEndpoint } from "../src/config";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

test("the production adapter accepts an internal deterministic browser worker", async () => {
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "browser://worker-injection",
    chatgptWeb: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
  };
  const worker = {
    async run(turn: BrowserTurn): Promise<string> {
      const prepared = await turn.prepare();
      prepared.release();
      turn.onTextDelta("deterministic production answer");
      return "deterministic production answer";
    },
    requestPreemptiveRetry: () => false,
  };
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: false,
    context: { messages: [{ role: "user", content: "Run production composition.", timestamp: 1 }] },
    options: { reasoning: "high" },
    _rawBody: {
      prompt_cache_key: "worker-injection-thread",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "worker-injection-thread", turn_id: "worker-injection-turn" }),
      },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Run production composition." }],
        internal_chat_message_metadata_passthrough: { turn_id: "worker-injection-turn" },
      }],
    },
  };
  const events: AdapterEvent[] = [];

  try {
    await createChatGptWebAdapter(provider, { worker }).runTurn!(
      parsed,
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(events.filter(event => event.type === "text_delta").map(event => event.text).join(""))
      .toContain("deterministic production answer");
    expect(events.at(-1)?.type).toBe("done");
  } finally {
    chatGptTurnSessions.clear();
  }
});

test("the production Enhanced adapter composes the tunneled output contract", async () => {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-output-compose-"));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  const environment = `<environment_context><cwd>${root}</cwd><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></environment_context>`;
  let observedTunnel = false;
  let observedPrompt = "";
  let invocation: Promise<unknown> | undefined;
  const events: AdapterEvent[] = [];
  const worker = {
    async run(turn: BrowserTurn): Promise<string> {
      observedTunnel = turn.tunneledOutput !== undefined;
      const prepared = await turn.prepare();
      try {
        observedPrompt = prepared.text;
        const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)![1]!;
        const { bindingId } = await callTurnBroker<{ bindingId: string }>(socket, { method: "claim", token });
        invocation = callTurnBroker(socket, {
          method: "invoke", bindingId, wireName: "exec_command", freeform: false, arguments: { cmd: "pwd" },
        }, null).catch(error => error);
        const progress = turn.externalProgress!;
        while (!progress.snapshot().lastToolBatchRevision) {
          await progress.waitForChange(progress.snapshot().revision, turn.abortSignal);
        }
        await progress.acknowledgeToolBatch(progress.snapshot().lastToolBatchRevision);
        return "deterministic tunneled answer";
      } finally {
        prepared.release();
      }
    },
  };
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    context: {
      tools: [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }],
      messages: [
        { role: "user", content: environment, timestamp: 1 },
        { role: "user", content: "Run tunneled production composition.", timestamp: 2 },
      ],
    },
    options: { reasoning: "high" },
    _rawBody: {
      prompt_cache_key: root,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: root, turn_id: "output-compose-turn" }),
      },
      input: [environment, "Run tunneled production composition."].map(text => ({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
        internal_chat_message_metadata_passthrough: { turn_id: "output-compose-turn" },
      })),
    },
  };

  try {
    await createChatGptWebAdapter({
      adapter: "chatgpt-web",
      baseUrl: `browser://${root}`,
      chatgptWeb: {
        brokerSocketPath: socket,
        localToolsEnabled: true,
        useEnhancedWebSessionMode: true,
        useEnhancedOutputTunnel: true,
      },
    }, { broker, worker }).runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
    expect(observedTunnel).toBeTrue();
    expect(observedPrompt).toContain("codex.control.output");
    expect(events.some(event => event.type === "tool_call_start")).toBeTrue();
  } finally {
    chatGptTurnSessions.clear();
    await broker.close();
    await invocation;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the production Enhanced adapter does not enable output tunneling without an exposed tool", async () => {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-output-no-tools-"));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  const environment = `<environment_context><cwd>${root}</cwd><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></environment_context>`;
  let observedTunnel = false;
  const worker = {
    async run(turn: BrowserTurn): Promise<string> {
      observedTunnel = turn.tunneledOutput !== undefined;
      const prepared = await turn.prepare();
      prepared.release();
      turn.onTextDelta("deterministic answer");
      return "deterministic answer";
    },
  };
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: false,
    context: { tools: [], messages: [
      { role: "user", content: environment, timestamp: 1 },
      { role: "user", content: "Answer without tools.", timestamp: 2 },
    ] },
    options: { reasoning: "high", toolChoice: "none" },
    _rawBody: {
      prompt_cache_key: root,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: root, turn_id: "output-no-tools-turn" }),
      },
      input: [environment, "Answer without tools."].map(text => ({
        type: "message", role: "user", content: [{ type: "input_text", text }],
        internal_chat_message_metadata_passthrough: { turn_id: "output-no-tools-turn" },
      })),
    },
  };

  try {
    await createChatGptWebAdapter({
      adapter: "chatgpt-web",
      baseUrl: `browser://${root}`,
      chatgptWeb: {
        brokerSocketPath: socket,
        localToolsEnabled: true,
        useEnhancedWebSessionMode: true,
        useEnhancedOutputTunnel: true,
      },
    }, { broker, worker }).runTurn!(parsed, { headers: new Headers() }, () => {});
    expect(observedTunnel).toBeFalse();
  } finally {
    chatGptTurnSessions.clear();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
