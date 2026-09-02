import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatGptCompletionEvidenceError, chatGptWebSurfaceError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { callTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import { CHATGPT_SAME_SURFACE_RECOVERY_PROMPT } from "../src/adapters/chatgpt-web/runtime-lifecycle";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const environmentXml = `<environment_context>
  <cwd>${process.cwd()}</cwd>
  <filesystem><workspace_roots><root>${process.cwd()}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`;

function brokerTestEndpoint(name: string): string {
  return process.platform === "win32"
    ? defaultBrokerEndpoint(join(tmpdir(), name), "win32")
    : join(tmpdir(), `${name}.sock`);
}

function initialRequest(): CodexParsedRequest {
  const turnId = "turn_submitted_recovery";
  const threadId = "thread_submitted_recovery";
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    context: {
      tools: [{ name: "exec_command", description: "Run a command", parameters: { type: "object" } }],
      messages: [
        { role: "user", content: environmentXml, timestamp: 1 },
        { role: "user", content: "Inspect the project", timestamp: 2 },
      ],
    },
    options: { reasoning: "high" },
    _rawBody: {
      prompt_cache_key: threadId,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
      },
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: environmentXml }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Inspect the project" }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      ],
    },
  };
}

function textOf(result: BrokerToolResult): string {
  return result.content.flatMap(item => (
    typeof item === "object" && item !== null
      && (item as { type?: unknown }).type === "text"
      && typeof (item as { text?: unknown }).text === "string"
      ? [(item as { text: string }).text]
      : []
  )).join("\n");
}

test("recovers missing completion evidence once in the active Web conversation", async () => {
  const socketPath = brokerTestEndpoint(`cgw-same-surface-${process.pid}-${Date.now()}`);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "browser://same-surface-recovery",
    chatgptWeb: {
      brokerSocketPath: socketPath,
      localToolsEnabled: true,
      solAvailable: true,
      proAvailable: true,
      useEnhancedWebSessionMode: true,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let browserStarts = 0;

  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserStarts += 1;
    const prepared = await turn.prepare();
    prepared.release();
    turn.onSubmitted?.();
    const retry = await turn.retryPromptForError?.(
      chatGptCompletionEvidenceError("completion evidence disappeared", false),
      1,
    );
    expect(retry).toMatchObject({
      text: CHATGPT_SAME_SURFACE_RECOVERY_PROMPT,
      replaceCandidate: true,
    });
    const answer = "Recovered in the retained conversation.";
    turn.onTextDelta(answer);
    return answer;
  };

  try {
    const request = initialRequest();
    request._canonicalContextComplete = true;
    const events: AdapterEvent[] = [];
    await createChatGptWebAdapter(provider).runTurn!(request, { headers: new Headers() }, event => events.push(event));

    expect(browserStarts).toBe(1);
    expect(events.filter(event => event.type === "text_delta").map(event => event.text).join(""))
      .toBe("Recovered in the retained conversation.");
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await TurnBroker.forSocket(socketPath).close();
  }
});

test("original Web session mode does not install same-conversation recovery", async () => {
  const socketPath = brokerTestEndpoint(`cgw-original-surface-${process.pid}-${Date.now()}`);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "browser://original-surface-recovery",
    chatgptWeb: {
      brokerSocketPath: socketPath,
      localToolsEnabled: true,
      solAvailable: true,
      proAvailable: true,
      useEnhancedWebSessionMode: false,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);

  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    expect(turn.retryPromptForError).toBeUndefined();
    const prepared = await turn.prepare();
    prepared.release();
    const answer = "Original mode answer.";
    turn.onTextDelta(answer);
    return answer;
  };

  try {
    const request = initialRequest();
    request._canonicalContextComplete = true;
    const events: AdapterEvent[] = [];
    await createChatGptWebAdapter(provider).runTurn!(request, { headers: new Headers() }, event => events.push(event));
    expect(events.filter(event => event.type === "text_delta").map(event => event.text).join(""))
      .toBe("Original mode answer.");
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await TurnBroker.forSocket(socketPath).close();
  }
});

test("rebuilds a submitted tool surface once from complete canonical state", async () => {
  const socketPath = brokerTestEndpoint(`cgw-submitted-recovery-${process.pid}-${Date.now()}`);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "browser://submitted-recovery",
    chatgptWeb: {
      brokerSocketPath: socketPath,
      localToolsEnabled: true,
      solAvailable: true,
      proAvailable: true,
      useEnhancedWebSessionMode: true,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const turnTokens: string[] = [];
  let browserStarts = 0;

  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserStarts += 1;
    const prepared = await turn.prepare();
    try {
      const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
      if (!token) throw new Error("turn token missing from compiled prompt");
      turnTokens.push(token);
      if (browserStarts === 1) {
        turn.onSubmitted?.();
        const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
        const progress = turn.externalProgress;
        if (!progress) throw new Error("tool-capable browser has no progress transport");
        const previousBatchRevision = progress.snapshot().lastToolBatchRevision;
        const resultPromise = callTurnBroker<BrokerToolResult>(socketPath, {
          method: "invoke",
          bindingId: claimed.bindingId,
          wireName: "exec_command",
          arguments: { cmd: "inspect" },
        }, 10_000);
        let snapshot = progress.snapshot();
        while (snapshot.lastToolBatchRevision <= previousBatchRevision) {
          snapshot = await progress.waitForChange(snapshot.revision, turn.abortSignal);
        }
        await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
        const result = await resultPromise;
        expect(textOf(result)).toContain("CANONICAL_RECOVERY_RESULT");
        throw chatGptWebSurfaceError("completion action disappeared after the tool result", false);
      }
      expect(prepared.modelInputText ?? prepared.text).toContain("CANONICAL_RECOVERY_RESULT");
      expect(prepared.modelInputText ?? prepared.text).toContain("Continue after the V2 boundary");
      const answer = "Recovered final answer.";
      turn.onTextDelta(answer);
      return answer;
    } finally {
      prepared.release();
    }
  };

  try {
    const adapter = createChatGptWebAdapter(provider);
    const first = initialRequest();
    const firstEvents: AdapterEvent[] = [];
    await adapter.runTurn!(first, { headers: new Headers() }, event => firstEvents.push(event));
    const call = firstEvents.find(
      (event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start",
    );
    expect(call?.name).toBe("exec_command");

    const continuation = structuredClone(first);
    continuation._canonicalContextComplete = true;
    continuation.context.messages.push(
      {
        role: "assistant",
        content: [{ type: "toolCall", id: call!.id, name: "exec_command", arguments: { cmd: "inspect" } }],
        timestamp: 3,
      },
      {
        role: "toolResult",
        toolCallId: call!.id,
        toolName: "exec_command",
        content: JSON.stringify({ output: "CANONICAL_RECOVERY_RESULT", exit_code: 0 }),
        isError: false,
        timestamp: 4,
      },
      { role: "user", content: "Continue after the V2 boundary", timestamp: 5 },
    );
    const raw = continuation._rawBody as { input: Array<Record<string, unknown>> };
    raw.input.push(
      {
        type: "function_call",
        call_id: call!.id,
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "inspect" }),
      },
      {
        type: "function_call_output",
        call_id: call!.id,
        output: JSON.stringify({ output: "CANONICAL_RECOVERY_RESULT", exit_code: 0 }),
      },
      {
        id: "agent_message_recovery",
        type: "agent_message",
        content: [{ type: "input_text", text: "Continue after the V2 boundary" }],
      },
    );

    const finalEvents: AdapterEvent[] = [];
    await adapter.runTurn!(continuation, { headers: new Headers() }, event => finalEvents.push(event));

    expect(browserStarts).toBe(2);
    expect(new Set(turnTokens).size).toBe(2);
    expect(finalEvents.filter(event => event.type === "tool_call_start")).toEqual([]);
    expect(finalEvents.filter(event => event.type === "text_delta").map(event => event.text).join(""))
      .toBe("Recovered final answer.");
    expect(finalEvents.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
    await expect(callTurnBroker(socketPath, { method: "claim", token: turnTokens[0]! }))
      .rejects.toThrow("already finished");
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await TurnBroker.forSocket(socketPath).close();
  }
});
