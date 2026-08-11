import { expect, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { extractChatGptTurnEnvironment, extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { defaultConfig } from "../src/config";
import { messagesCountTokensRequest, messagesRequest } from "../src/messages";
import type { CodexProviderConfig } from "../src/types";

const headers = {
  "content-type": "application/json",
  "x-claude-code-session-id": "session-123",
  "x-claude-code-agent-id": "agent-main",
};

function request(body: Record<string, unknown>, path = "/v1/messages", signal?: AbortSignal) {
  return new Request(`http://127.0.0.1:17841${path}?beta=true`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
}

test("translates a Claude Code message into the existing ChatGPT Web adapter", async () => {
  const seenProviders: CodexProviderConfig[] = [];
  const adapterFactory = (provider: CodexProviderConfig): ProviderAdapter => {
    seenProviders.push(provider);
    return {
      name: "messages-test",
      async runTurn(parsed, _incoming, emit) {
        expect(extractChatGptTurnIdentity(parsed)).toMatchObject({
          threadId: expect.stringContaining("claude_session-123"),
          turnId: expect.stringContaining("claude_agent-main"),
        });
        expect((parsed._rawBody as { client_metadata: Record<string, unknown> }).client_metadata).toMatchObject({
          claude_subagent: true,
          claude_retain_conversation: false,
        });
        expect(extractChatGptTurnEnvironment(parsed).cwd).toBe("G:\\claude-project");
        expect(parsed.context.systemPrompt).toContain("Available agent types for the Agent tool: Explore");
        expect(parsed.context.tools).toEqual([{
          name: "read_file",
          description: "Read one file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        }]);
        expect(JSON.stringify(parsed.context.messages)).toContain("Inspect this image");
        expect(parsed.context.messages.some(message => message.role === "user"
          && Array.isArray(message.content)
          && message.content.some(part => part.type === "image"))).toBe(true);
        emit({ type: "thinking_delta", thinking: "Inspecting the request" });
        emit({ type: "text_delta", text: "Ready.", phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 120, outputTokens: 8 } });
      },
    };
  };

  const response = await messagesRequest(request({
    model: "chatgpt-web-high",
    max_tokens: 2048,
    system: "You are Claude Code.\n- Primary working directory: G:\\claude-project",
    messages: [
      { role: "user", content: [
        { type: "text", text: "Inspect this image" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
      ] },
      { role: "system", content: [{ type: "text", text: "Available agent types for the Agent tool: Explore" }] },
    ],
    tools: [{
      name: "read_file",
      description: "Read one file",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    }],
  }), defaultConfig("full"), adapterFactory);

  expect(response.status).toBe(200);
  expect(seenProviders).toHaveLength(1);
  const body = await response.json() as Record<string, any>;
  expect(body).toMatchObject({ type: "message", role: "assistant", model: "chatgpt-web-high", stop_reason: "end_turn" });
  expect(body.content).toEqual([
    expect.objectContaining({ type: "thinking", thinking: "Inspecting the request" }),
    { type: "text", text: "Ready." },
  ]);
  expect(body.usage).toEqual({ input_tokens: 120, output_tokens: 8 });
});

test("accepts a model id returned by Claude gateway discovery", async () => {
  const response = await messagesRequest(request({
    model: "claude-chatgpt-web-high",
    max_tokens: 100,
    messages: [{ role: "user", content: "test" }],
  }), defaultConfig("full"), () => ({
    name: "messages-discovered-model-test",
    async runTurn(parsed, _incoming, emit) {
      expect(parsed.modelId).toBe("gpt-5.6-sol");
      expect(parsed.options.reasoning).toBe("high");
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));

  expect(response.status).toBe(200);
});

test("answers Claude Code title requests without opening a retained browser turn", async () => {
  let adapterRuns = 0;
  const response = await messagesRequest(request({
    model: "claude-chatgpt-web-high",
    max_tokens: 64,
    stream: true,
    system: [
      { type: "text", text: "Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding session." },
      { type: "text", text: "Return JSON with a single \"title\" field." },
    ],
    messages: [{ role: "user", content: [{
      type: "text",
      text: "<session>\n請對目前的repo進行code review\n</session>\n\nWrite the title in the predominant language of the session.",
    }] }],
    output_config: {
      effort: "high",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
          additionalProperties: false,
        },
      },
    },
  }), defaultConfig("full"), () => ({
    name: "messages-title-must-not-run",
    async runTurn() { adapterRuns += 1; },
  }));

  expect(response.status).toBe(200);
  expect(adapterRuns).toBe(0);
  expect(await response.text()).toContain(JSON.stringify({ title: "請對目前的repo進行code review" }).replaceAll('"', '\\"'));
});

test("streams Anthropic tool-use events and accepts unknown beta fields", async () => {
  const response = await messagesRequest(request({
    model: "chatgpt-web/high",
    max_tokens: 1024,
    stream: true,
    messages: [{ role: "user", content: "Read package.json" }],
    unknown_future_field: { accepted: true },
  }), defaultConfig("full"), () => ({
    name: "messages-stream-test",
    async runTurn(_parsed, _incoming, emit) {
      emit({ type: "heartbeat" });
      emit({ type: "redacted_thinking", data: "opaque-redacted" });
      emit({ type: "tool_call_start", id: "toolu_123", name: "read_file" });
      emit({ type: "tool_call_delta", arguments: "{\"path\":\"package.json\"}" });
      emit({ type: "tool_call_end" });
      emit({ type: "done", stopReason: "tool_use", endTurn: false, usage: { inputTokens: 80, outputTokens: 12 } });
    },
  }));

  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const body = await response.text();
  expect(body).toContain("event: ping");
  expect(body).toContain('"type":"input_json_delta"');
  expect(body).toContain('"type":"redacted_thinking","data":"opaque-redacted"');
  expect(body).toContain('"partial_json":"{\\"path\\":\\"package.json\\"}"');
  expect(body).toContain('"stop_reason":"tool_use"');
  expect(body).toContain("event: message_stop");
});

test("keeps incremental Claude commentary in one text block across transient thinking", async () => {
  const response = await messagesRequest(request({
    model: "chatgpt-web/high",
    max_tokens: 1024,
    stream: true,
    messages: [{ role: "user", content: "Describe the bridge" }],
  }), defaultConfig("full"), () => ({
    name: "messages-commentary-boundary-test",
    async runTurn(_parsed, _incoming, emit) {
      emit({ type: "text_delta", text: "Cod", phase: "commentary" });
      emit({ type: "thinking_delta", thinking: "Transient Web status" });
      emit({ type: "text_delta", text: "ex Native", phase: "commentary" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));

  const body = await response.text();
  const textStarts = body.match(/"content_block":\{"type":"text","text":""\}/g) ?? [];
  const deltas = [...body.matchAll(/"delta":\{"type":"text_delta","text":"([^"]*)"\}/g)]
    .map(match => match[1]);
  expect(textStarts).toHaveLength(1);
  expect(deltas.join("")).toBe("Codex Native");
  expect(body).not.toContain("Transient Web status");
});

test("cancelling a streamed Claude response aborts its active browser turn", async () => {
  const requestAbort = new AbortController();
  let releaseStarted!: () => void;
  let releaseFinished!: () => void;
  let browserAborted = false;
  const started = new Promise<void>(resolve => { releaseStarted = resolve; });
  const finished = new Promise<void>(resolve => { releaseFinished = resolve; });
  const response = await messagesRequest(request({
    model: "chatgpt-web/high",
    max_tokens: 1024,
    stream: true,
    messages: [{ role: "user", content: "Keep working" }],
  }, "/v1/messages", requestAbort.signal), defaultConfig("full"), () => ({
    name: "messages-stream-cancel-test",
    async runTurn(_parsed, incoming) {
      releaseStarted();
      await new Promise<void>(resolve => incoming.abortSignal?.addEventListener("abort", () => {
        browserAborted = true;
        resolve();
      }, { once: true }));
      releaseFinished();
    },
  }));

  await started;
  const reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  await reader.cancel("Claude Code interrupted the turn");
  await Bun.sleep(0);
  const abortedByStream = browserAborted;
  requestAbort.abort();
  await finished;

  expect(abortedByStream).toBe(true);
});

test("replays Claude thinking and tool results into the existing tool loop", async () => {
  const response = await messagesRequest(request({
    model: "chatgpt-web/high",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "Read package.json" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "I should inspect the file", signature: "opaque-signature" },
        { type: "redacted_thinking", data: "opaque-redacted" },
        { type: "tool_use", id: "toolu_123", name: "read_file", input: { path: "package.json" } },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_123", content: [
        { type: "text", text: "{\"name\":\"bridge\"}" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
      ] }] },
    ],
    tools: [{ name: "read_file", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "read_file" },
  }), defaultConfig("full"), () => ({
    name: "messages-tool-result-test",
    async runTurn(parsed, _incoming, emit) {
      expect(parsed.options.toolChoice).toEqual({ name: "read_file" });
      expect(parsed.context.messages.some(message => message.role === "assistant"
        && message.content.some(part => part.type === "toolCall" && part.id === "toolu_123"))).toBe(true);
      expect(parsed.context.messages.some(message => message.role === "toolResult"
        && message.toolCallId === "toolu_123"
        && Array.isArray(message.content)
        && message.content.some(part => part.type === "image"))).toBe(true);
      emit({ type: "text_delta", text: "The package is named bridge." });
      emit({ type: "done", stopReason: "stop", usage: { inputTokens: 90, outputTokens: 7 } });
    },
  }));

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ stop_reason: "end_turn" });
});

test("counts Claude input with the same conservative browser estimator", async () => {
  const response = await messagesCountTokensRequest(request({
    model: "chatgpt-web/high",
    messages: [{ role: "user", content: "Inspect the repository" }],
  }, "/v1/messages/count_tokens"), defaultConfig("full"));
  expect(response.status).toBe(200);
  const body = await response.json() as { input_tokens: number };
  expect(body.input_tokens).toBeGreaterThan(8_000);
});

test("preserves structured browser failures in the Anthropic error envelope", async () => {
  const response = await messagesRequest(request({
    model: "chatgpt-web-high",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Continue" }],
  }), defaultConfig("full"), () => ({
    name: "messages-error-test",
    async runTurn() {
      throw new ChatGptWebAdapterError("Retained conversation unavailable", {
        status: 409,
        errorType: "invalid_request_error",
        code: "conversation_unavailable",
        retryable: false,
      });
    },
  }));

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    type: "error",
    error: { type: "invalid_request_error", message: "Retained conversation unavailable" },
  });
});

test("recognizes the Claude Code compact harness and returns its summary envelope", async () => {
  const config = { ...defaultConfig("full"), useNewCompactMode: true };
  const response = await messagesRequest(request({
    model: "chatgpt-web/high",
    max_tokens: 4096,
    system: "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.",
    messages: [{ role: "user", content: "Your task is to create a detailed summary of this conversation. Preserve the implementation state." }],
    tools: [{ name: "read_file", input_schema: { type: "object" } }],
  }), config, provider => ({
    name: "messages-compact-test",
    async runTurn(parsed, _incoming, emit) {
      expect(provider.chatgptWeb?.useNewCompactMode).toBe(true);
      expect(parsed._compactionRequest).toBeUndefined();
      expect(parsed.context.tools).toBeUndefined();
      emit({ type: "text_delta", text: "Continue from the existing working tree." });
      emit({ type: "done", stopReason: "stop", usage: { inputTokens: 200, outputTokens: 20 } });
    },
  }));

  expect(response.status).toBe(200);
  const body = await response.json() as { content: Array<{ type: string; text: string }> };
  expect(body.content).toEqual([{
    type: "text",
    text: "<analysis>Conversation compacted by the active ChatGPT Web agent.</analysis>\n<summary>Continue from the existing working tree.</summary>",
  }]);
});
