import { afterEach, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";
import { chatCompletionApiKey, chatCompletionRequestGuard, chatCompletionRequest, publicChatError } from "../src/chat-completions/http";
import { ChatCompletionError } from "../src/chat-completions/contract";
import type { ChatCompletionExecutor } from "../src/chat-completions/runtime";

const key = "local-test-key-not-a-real-credential-0123456789";
const previous = process.env.CODEX_CHATGPT_WEB_API_KEY;
afterEach(() => { if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_API_KEY; else process.env.CODEX_CHATGPT_WEB_API_KEY = previous; });
const body = (extra: Record<string, unknown> = {}) => ({ model: "chatgpt-web/high", messages: [{ role: "user", content: "test" }], ...extra });
function listener(execute: ChatCompletionExecutor) {
  process.env.CODEX_CHATGPT_WEB_API_KEY = key;
  const config = defaultConfig(); config.port = 0; config.controlToken = "native-test-control-token";
  return startServer(config, { chatCompletionExecutor: execute });
}
function send(server: ReturnType<typeof startServer>, data: unknown, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...headers }, body: JSON.stringify(data) });
}
test("disabled by default and refuses shared/native or malformed admission keys", async () => {
  delete process.env.CODEX_CHATGPT_WEB_API_KEY;
  expect(chatCompletionApiKey(defaultConfig())).toBeUndefined();
  expect(() => chatCompletionApiKey(defaultConfig(), "short")).toThrow();
  expect(() => chatCompletionApiKey({ ...defaultConfig(), controlToken: key }, key)).toThrow();
  const server = startServer({ ...defaultConfig(), port: 0 });
  try { expect((await send(server, body())).status).toBe(404); } finally { await server.stop(true); }
});
test("key cannot access native/admin routes; invalid requests never enter executor", async () => {
  let calls = 0; const server = listener(async () => { calls++; return { answer: "done" }; });
  try {
    for (const path of ["/healthz", "/admin/drain", "/admin/shutdown", "/v1/responses", "/v1/messages", "/v1/responses/compact", "/unknown"]) {
      for (const method of ["GET", "POST"]) expect((await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { authorization: `Bearer ${key}` } })).status).toBe(403);
    }
    expect((await send(server, body(), { authorization: "Bearer invalid" })).status).toBe(401);
    expect((await send(server, body(), { origin: "https://example.invalid" })).status).toBe(403);
    expect((await send(server, body(), { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await send(server, body(), { "content-type": "text/plain" })).status).toBe(415);
    expect((await send(server, body({ model: "unknown/native" }))).status).toBe(400);
    expect((await send(server, body({ metadata: { nativeConnector: true } }))).status).toBe(400);
    expect((await send(server, body({ messages: [{ role: "user", content: "x".repeat(4 * 1024 * 1024) }] }))).status).toBe(413);
    expect(calls).toBe(0);
    const models = await fetch(`http://127.0.0.1:${server.port}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
    expect(models.status).toBe(200); const catalog = await models.json() as any;
    expect(catalog.object).toBe("list"); expect(catalog.data.length).toBeGreaterThan(0);
    expect(catalog.data.every((m: any) => m.id.startsWith("chatgpt-web/") && m.object === "model")).toBeTrue();
  } finally { await server.stop(true); }
});

test("Host, peer and Origin checks also protect model reads against DNS rebinding", () => {
  for (const headers of ([{ host: "example.invalid:1234" }, { host: "127.0.0.1:1235" }, { host: "127.0.0.1:1234", origin: "null" },
    { host: "127.0.0.1:1234", origin: "http://localhost:9999" }] as Record<string, string>[])) {
    const req = new Request("http://127.0.0.1:1234/v1/models", { headers: { authorization: `Bearer ${key}`, ...headers } });
    expect(chatCompletionRequestGuard(req, "/v1/models", key, 1234)?.status).toBe(403);
  }
  const req = new Request("http://127.0.0.1:1234/v1/models", { headers: { host: "127.0.0.1:1234", authorization: `Bearer ${key}` } });
  expect(chatCompletionRequestGuard(req, "/v1/models", key, 1234, "192.0.2.1")?.status).toBe(403);
});

test("retired local API keys cannot fall through to the native model catalog", () => {
  const req = new Request("http://127.0.0.1:1234/v1/models", {
    headers: { host: "127.0.0.1:1234", authorization: "Bearer sk-local-retired-key" },
  });
  expect(chatCompletionRequestGuard(req, "/v1/models", key, 1234)?.status).toBe(401);
  expect(chatCompletionRequestGuard(req, "/v1/models", undefined, 1234)?.status).toBe(404);
  const native = new Request("http://127.0.0.1:1234/v1/models", {
    headers: { host: "127.0.0.1:1234", authorization: "Bearer private-session-token" },
  });
  expect(chatCompletionRequestGuard(native, "/v1/models", key, 1234)).toBeUndefined();
});

test("JSON and SSE share Chat Completions semantics, not Responses events", async () => {
  const server = listener(async (_input, _config, _signal, onText) => { onText("hello "); onText("world"); return { answer: "hello world" }; });
  try {
    const json = await (await send(server, body())).json() as any;
    expect(json.object).toBe("chat.completion"); expect(json.choices[0]).toMatchObject({ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hello world" } });
    expect(json.usage).toBeUndefined();
    const stream = await (await send(server, body({ stream: true }))).text();
    expect(stream).not.toContain("response.completed"); expect(stream.match(/\[DONE\]/g)).toHaveLength(1);
    const frames = stream.split("\n\n").filter(x => x.startsWith("data: {")).map(x => JSON.parse(x.slice(6)));
    expect(new Set(frames.map(x => x.id)).size).toBe(1);
    expect(frames.every(x => x.object === "chat.completion.chunk")).toBeTrue();
    expect(frames.map(x => x.choices[0].delta.content ?? "").join("")).toBe("hello world");
    expect(frames.at(-1).choices[0].finish_reason).toBe("stop");
  } finally { await server.stop(true); }
});

test("tool SSE is buffered, complete, indexed and round-trippable with a tool result", async () => {
  let round = 0;
  const tools = [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }];
  const server = listener(async (input, _config, _signal, onText) => {
    round++; onText("this internal envelope is never streamed");
    if (round === 1) return { answer: '{"content":null,"tool_calls":[{"name":"read","arguments":{"path":"safe.txt"}}]}' };
    expect(input.messages.at(-1)?.role).toBe("tool"); return { answer: '{"content":"done","tool_calls":[]}' };
  });
  try {
    const stream = await (await send(server, body({ stream: true, tools }))).text();
    expect(stream).not.toContain("internal envelope");
    const frames = stream.split("\n\n").filter(x => x.startsWith("data: {")).map(x => JSON.parse(x.slice(6)));
    const call = frames.find(x => x.choices[0].delta.tool_calls).choices[0].delta.tool_calls[0];
    expect(call.index).toBe(0); expect(JSON.parse(call.function.arguments)).toEqual({ path: "safe.txt" });
    expect(frames.at(-1).choices[0].finish_reason).toBe("tool_calls");
    const { index: _index, ...historyCall } = call;
    const result = await (await send(server, body({ tools, messages: [...body().messages,
      { role: "assistant", content: null, tool_calls: [historyCall] }, { role: "tool", tool_call_id: call.id, content: "safe result" }] }))).json() as any;
    expect(result.choices[0].message.content).toBe("done"); expect(round).toBe(2);
  } finally { await server.stop(true); }
});

test("stream failure emits one standard error without success completion or leaked exception content", async () => {
  const server = listener(async (_i, _c, _s, onText) => { onText("prefix"); throw new Error("private-secret-and-path"); });
  try {
    const text = await (await send(server, body({ stream: true }))).text();
    expect(text).toContain('"error":'); expect(text).not.toContain("private-secret"); expect(text).not.toContain("[DONE]"); expect(text).not.toContain('"finish_reason":"stop"');
    const json = await send(server, body()); expect(json.status).toBe(502);
    expect(publicChatError(new Error("private" )).body.error.message).not.toContain("private");
  } finally { await server.stop(true); }
});

test("service drain is shared with general client admission", async () => {
  const server = listener(async () => ({ answer: "done" }));
  try {
    const drain = await fetch(`http://127.0.0.1:${server.port}/admin/drain`, { method: "POST", headers: { authorization: "Bearer native-test-control-token" } });
    expect(drain.status).toBe(200); expect((await send(server, body())).status).toBe(503);
  } finally { await server.stop(true); }
});

test("malformed function output is an error after headers, never a fake final answer", async () => {
  const server = listener(async () => ({ answer: "{unfinished" }));
  try {
    const response = await send(server, body({ stream: true, tools: [{ type: "function", function: { name: "read" } }] }));
    expect(response.status).toBe(200); const text = await response.text();
    expect(text).toContain("model_protocol_error"); expect(text).not.toContain("[DONE]");
  } finally { await server.stop(true); }
});

test("a stalled SSE consumer has bounded buffering and cancels the original executor", async () => {
  let didAbort = false;
  let sent = 0;
  const response = await chatCompletionRequest(new Request("http://127.0.0.1/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body({ stream: true })),
  }), defaultConfig(), new AbortController().signal, async (_i, _c, signal, onText) => {
    for (; sent < 100000; sent++) {
      if (signal.aborted) { didAbort = true; signal.throwIfAborted(); }
      onText("a");
    }
    return { answer: "a".repeat(sent) };
  });
  // No body reads were made during production; frame overhead is bounded, not only text units.
  expect(didAbort).toBeTrue(); expect(sent).toBeLessThan(100000);
  await expect(response.text()).rejects.toThrow("bounded stream queue");
});
