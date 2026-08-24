import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { completeChatGptToolResults } from "../src/adapters/chatgpt-web/tool-result-delivery";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
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
  const turnId = "turn_v2_boundary";
  const threadId = "thread_v2_boundary";
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
  return result.content
    .filter((item): item is { type: "text"; text: string } => (
      typeof item === "object" && item !== null
      && (item as { type?: unknown }).type === "text"
      && typeof (item as { text?: unknown }).text === "string"
    ))
    .map(item => item.text)
    .join("\n");
}

test("reconciles superseded calls against complete canonical request generations", () => {
  const session = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve("turn_superseded"),
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => {},
  });
  session.observeCanonicalRequest({ ...initialRequest(), _canonicalContextComplete: true });
  session.setOutstanding([
    { callId: "call_one", wireName: "exec_command", freeform: false, arguments: { cmd: "one" } },
    { callId: "call_two", wireName: "exec_command", freeform: false, arguments: { cmd: "two" } },
  ]);

  const revision = initialRequest();
  revision._canonicalContextComplete = true;
  revision.context.messages.push({
    role: "assistant",
    content: [{ type: "toolCall", id: "call_two", name: "exec_command", arguments: { cmd: "two" } }],
    timestamp: 3,
  });
  session.observeCanonicalRequest(revision);

  expect(session.supersedeOutstanding()).toEqual(["call_one", "call_two"]);
  expect(session.outstanding()).toEqual([]);
  expect(session.unresolvedSupersededResultIds()).toEqual(["call_two"]);

  const resolved = structuredClone(revision);
  resolved.context.messages.push({
    role: "toolResult",
    toolCallId: "call_two",
    toolName: "exec_command",
    content: "done",
    isError: false,
    timestamp: 4,
  });
  session.observeCanonicalRequest(resolved);
  expect(session.unresolvedSupersededResultIds()).toEqual([]);
});

test("keeps same-generation and incomplete superseded calls fail-closed", () => {
  const sameGeneration = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve("turn_same_generation"),
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => {},
  });
  sameGeneration.observeCanonicalRequest({ ...initialRequest(), _canonicalContextComplete: true });
  sameGeneration.setOutstanding([
    { callId: "call_same", wireName: "exec_command", freeform: false, arguments: {} },
  ]);
  sameGeneration.supersedeOutstanding();
  expect(sameGeneration.unresolvedSupersededResultIds()).toEqual(["call_same"]);

  const incomplete = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve("turn_incomplete"),
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => {},
  });
  incomplete.observeCanonicalRequest({ ...initialRequest(), _canonicalContextComplete: true });
  incomplete.setOutstanding([
    { callId: "call_incomplete", wireName: "exec_command", freeform: false, arguments: {} },
  ]);
  incomplete.observeCanonicalRequest(initialRequest());
  incomplete.supersedeOutstanding();
  expect(incomplete.unresolvedSupersededResultIds()).toEqual(["call_incomplete"]);
});

test("does not consume steering or outstanding calls for a partial parallel result batch", async () => {
  const session = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve("turn_partial"),
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => {},
  });
  session.setOutstanding([
    { callId: "call_one", wireName: "exec_command", freeform: false, arguments: { cmd: "one" } },
    { callId: "call_two", wireName: "exec_command", freeform: false, arguments: { cmd: "two" } },
  ]);
  session.queueSteering("new guidance");

  await expect(completeChatGptToolResults(session, { completeTool: () => {} }, "turn_partial", [{
    role: "toolResult",
    toolCallId: "call_one",
    toolName: "exec_command",
    content: "one",
    isError: false,
    timestamp: 1,
  }])).rejects.toThrow("Codex returned 1 of 2 results");
  expect(session.outstanding().map(call => call.callId)).toEqual(["call_one", "call_two"]);
  expect(session.takePendingSteering()).toBe("new guidance");
});

test("delivers a canonical tool result before a later native V2 revision", async () => {
  const socketPath = brokerTestEndpoint(`cgw-v2-boundary-${process.pid}-${Date.now()}`);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "browser://v2-boundary",
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
  const nativeResults: string[] = [];
  let browserStarts = 0;

  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserStarts += 1;
    const prepared = await turn.prepare();
    try {
      const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
      if (!token) throw new Error("turn token missing from compiled prompt");
      const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
      nativeResults.push(textOf(await callTurnBroker<BrokerToolResult>(socketPath, {
        method: "invoke",
        bindingId: claimed.bindingId,
        wireName: "exec_command",
        arguments: { cmd: "inspect" },
      }, 10_000)));
      nativeResults.push(textOf(await callTurnBroker<BrokerToolResult>(socketPath, {
        method: "invoke",
        bindingId: claimed.bindingId,
        wireName: "exec_command",
        arguments: { cmd: "next-boundary" },
      }, 10_000)));
      const answer = "Boundary ordering completed.";
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
        content: JSON.stringify({ output: "CANONICAL_TOOL_RESULT", exit_code: 0 }),
        isError: false,
        timestamp: 4,
      },
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
        output: JSON.stringify({ output: "CANONICAL_TOOL_RESULT", exit_code: 0 }),
      },
      {
        id: "agent_message_boundary",
        type: "agent_message",
        content: [{ type: "input_text", text: "Continue with the V2 agent update." }],
      },
    );

    const finalEvents: AdapterEvent[] = [];
    await adapter.runTurn!(continuation, { headers: new Headers() }, event => finalEvents.push(event));

    expect(browserStarts).toBe(1);
    expect(nativeResults[0]).toContain("CANONICAL_TOOL_RESULT");
    expect(nativeResults[0]).not.toContain("Continue with the V2 agent update");
    expect(nativeResults[1]).toContain("Continue with the V2 agent update");
    expect(finalEvents.some(event => event.type === "tool_call_start")).toBeFalse();
    expect(finalEvents.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await TurnBroker.forSocket(socketPath).close();
  }
});
