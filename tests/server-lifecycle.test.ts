import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatGptWebTraceId } from "../src/adapters/chatgpt-web";
import { ChatGptAccountSafety, chatGptAccountSafety } from "../src/adapters/chatgpt-web/account-safety";
import { runStructuredCompactionOnce } from "../src/adapters/chatgpt-web/compaction-handoff";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, closeTurnBrokers, RemoteTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint, defaultConfig, providerConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { compactRequest, HttpTurnCounter, ModelCatalogFetches, responseRequest, routeChatGptWebRequest, startServer } from "../src/server";

test("DEV harness configuration cannot bind a Responses listener", () => {
  const config = { ...defaultConfig("browser-only"), purpose: "dev-harness" as const, port: 0 };
  expect(() => startServer(config)).toThrow("cannot start a Responses listener");
});

for (const reason of [undefined, "browser_surface_bootstrap_timeout", "helper_heartbeat_expired"] as const)
test(`targeted cancellation preserves peer turns and its cause: ${reason ?? "user close"}`, async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  chatGptTurnSessions.clear();
  let rejectTarget!: (error: Error) => void;
  let targetCancelled = 0;
  let otherCancelled = 0;
  let finishPhysical!: () => void;
  const closingSurface = new Promise<void>(resolve => { finishPhysical = resolve; });
  const targetBrowser = new Promise<string>((_resolve, reject) => { rejectTarget = reject; });
  const target = chatGptTurnSessions.getOrCreate("target-key", () => ({
    mode: "read-only",
    browser: targetBrowser,
    physicalSettlement: reason ? targetBrowser.then(() => undefined, () => undefined) : closingSurface,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: reason => {
      targetCancelled += 1;
      rejectTarget(reason ?? new Error("tab closed"));
    },
  }), undefined, undefined, undefined, "trace_target");
  chatGptTurnSessions.getOrCreate("other-key", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { otherCancelled += 1; },
  }), undefined, undefined, undefined, "trace_other");

  try {
    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/admin/cancel-turn`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer invalid" },
      body: JSON.stringify({ traceId: "trace_target", ...(reason ? { reason } : {}) }),
    });
    expect(unauthorized.status).toBe(401);

    const response = await fetch(`http://127.0.0.1:${server.port}/admin/cancel-turn`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.controlToken}`,
      },
      body: JSON.stringify({ traceId: "trace_target", ...(reason ? { reason } : {}) }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      trace_id: "trace_target",
      cancelled_browser_turns: 1,
      cancelled_broker_turns: 0,
      active_browser_turns: reason ? 1 : 2,
    });
    finishPhysical();
    await target.browserOutcome;
    await target.physicalSettlement;
    expect(chatGptTurnSessions.activeCount()).toBe(1);
    expect(targetCancelled).toBe(1);
    expect(otherCancelled).toBe(0);
    expect(target.settledOutcome()).toMatchObject({ type: "error", error: { code: reason ?? "client_cancelled", retryable: false } });
    expect(chatGptTurnSessions.getOrCreate("target-key", () => {
      throw new Error("cancelled trace must remain terminal");
    }, undefined, undefined, undefined, "trace_target")).toBe(target);
  } finally {
    chatGptTurnSessions.clear();
    await server.stop(true);
  }
});

test("model catalog health distinguishes no request, transport failure, upstream denial, and recovery without secrets", async () => {
  let outcome: "transport" | "denied" | "invalid" | "ready" = "transport";
  const server = startServer({ ...defaultConfig("browser-only"), port: 0 }, {
    fetchUpstream: async () => {
      if (outcome === "transport") throw Object.assign(new Error("private proxy credentials and host"), { code: "UnsupportedProxyProtocol" });
      if (outcome === "denied") return new Response("private upstream account detail", { status: 403 });
      if (outcome === "invalid") return Response.json({ models: [] });
      return Response.json({ models: [{ slug: "native", visibility: "list", supported_reasoning_levels: [] }] });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const health = async () => await (await fetch(`${base}/healthz`)).json() as Record<string, any>;
  try {
    expect(await health()).toMatchObject({ model_catalog_requests: 0, last_model_catalog_result: null });
    const unauthenticated = await fetch(`${base}/v1/models`);
    expect(unauthenticated.status).toBe(502);
    await unauthenticated.text();
    expect((await health()).last_model_catalog_result.failure.stage).toBe("request");
    for (const [next, status, stage] of [
      ["transport", 502, "transport"], ["denied", 403, "upstream"], ["invalid", 502, "catalog"], ["ready", 200, undefined],
    ] as const) {
      outcome = next;
      const response = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer private-session-token" } });
      expect(response.status).toBe(status);
      await response.text();
      const snapshot = await health();
      expect(snapshot.last_model_catalog_result).toMatchObject({ status });
      expect(snapshot.last_model_catalog_result.failure?.stage).toBe(stage);
      if (next === "transport") expect(snapshot.last_model_catalog_result.failure.code).toBe("UnsupportedProxyProtocol");
      expect(JSON.stringify(snapshot)).not.toContain("private");
      expect(snapshot.successful_model_catalog_requests).toBe(next === "ready" ? 1 : 0);
    }
    expect((await health()).model_catalog_requests).toBe(5);
  } finally {
    await server.stop(true);
  }
});

async function waitForTurnCount(turns: HttpTurnCounter, expected: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (turns.count() !== expected && Date.now() < deadline) await Bun.sleep(5);
  expect(turns.count()).toBe(expected);
}

test("HTTP turn tracking follows the response stream instead of Bun's global request count", async () => {
  const turns = new HttpTurnCounter();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = await turns.track(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
    },
  })));
  const reader = response.body!.getReader();

  expect(turns.count()).toBe(1);
  source.enqueue(new TextEncoder().encode("data"));
  expect((await reader.read()).done).toBe(false);
  expect(turns.count()).toBe(1);
  source.close();
  expect((await reader.read()).done).toBe(true);
  await waitForTurnCount(turns, 0);
});

test("HTTP turn tracking releases a cancelled response stream", async () => {
  const failures: unknown[] = [];
  const turns = new HttpTurnCounter(failure => failures.push(failure));
  const request = new AbortController();
  const response = await turns.track(
    async () => new Response(new ReadableStream<Uint8Array>()),
    request.signal,
  );

  expect(turns.count()).toBe(1);
  const cancelled = response.body!.cancel();
  request.abort("client disconnected");
  await cancelled;
  await waitForTurnCount(turns, 0);
  expect(failures).toEqual([]);
});

test("HTTP turn tracking uses a tee branch on Windows", async () => {
  const turns = new HttpTurnCounter();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const original = new ReadableStream<Uint8Array>({
    start(controller) { source = controller; },
  });
  const response = await turns.track(async () => new Response(original), undefined, "win32");
  const reader = response.body!.getReader();

  source.enqueue(new TextEncoder().encode("safe"));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("safe");
  source.close();
  expect((await reader.read()).done).toBe(true);
  await waitForTurnCount(turns, 0);
});

test("HTTP turn tracking uses direct pull and cancellation outside Windows", async () => {
  const turns = new HttpTurnCounter();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let sourceCancelled = false;
  const original = new ReadableStream<Uint8Array>({
    start(controller) { source = controller; },
    cancel() { sourceCancelled = true; },
  });
  const response = await turns.track(async () => new Response(original), undefined, "darwin");
  const reader = response.body!.getReader();

  source.enqueue(new TextEncoder().encode("native-pull"));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("native-pull");
  await reader.cancel("client disconnected");
  await waitForTurnCount(turns, 0);
  expect(sourceCancelled).toBe(true);
});

test("HTTP turn tracking reports a content-free direct stream failure", async () => {
  const failures: unknown[] = [];
  const turns = new HttpTurnCounter(failure => failures.push(failure));
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = await turns.track(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { source = controller; },
  })), undefined, "darwin");
  const reader = response.body!.getReader();

  source.enqueue(new TextEncoder().encode("safe"));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("safe");
  source.error(Object.assign(new TypeError("sensitive upstream detail"), { code: "ECONNRESET" }));
  await expect(reader.read()).rejects.toThrow("sensitive upstream detail");
  await waitForTurnCount(turns, 0);

  expect(failures).toEqual([{
    stage: "direct",
    platform: "darwin",
    chunks: 1,
    bytes: 4,
    errorName: "TypeError",
    errorCode: "ECONNRESET",
  }]);
  expect(JSON.stringify(failures)).not.toContain("sensitive upstream detail");
});

test("HTTP turn tracking reports a content-free Windows lifecycle stream failure", async () => {
  const failures: unknown[] = [];
  const turns = new HttpTurnCounter(failure => failures.push(failure));
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = await turns.track(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { source = controller; },
  })), undefined, "win32");
  const reader = response.body!.getReader();

  source.enqueue(new TextEncoder().encode("event"));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("event");
  source.error(Object.assign(new TypeError("private response fragment"), { code: "ECONNRESET" }));
  await expect(reader.read()).rejects.toThrow("private response fragment");
  await waitForTurnCount(turns, 0);

  expect(failures).toEqual([{
    stage: "lifecycle",
    platform: "win32",
    chunks: 1,
    bytes: 5,
    errorName: "TypeError",
    errorCode: "ECONNRESET",
  }]);
  expect(JSON.stringify(failures)).not.toContain("private response fragment");
});

test("HTTP turn tracking releases a stream whose client disconnected without cancelling", async () => {
  const turns = new HttpTurnCounter();
  const client = new AbortController();
  let cancelled = false;
  const response = await turns.track(
    async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    })),
    client.signal,
  );

  expect(turns.count()).toBe(1);
  client.abort();
  await Bun.sleep(0);
  expect(turns.count()).toBe(0);
  expect(cancelled).toBe(true);
  expect(response.body).not.toBeNull();
});

test("HTTP turn tracking releases a stream requested by an already disconnected client", async () => {
  const turns = new HttpTurnCounter();
  const client = new AbortController();
  client.abort();
  const response = await turns.track(async () => new Response(new ReadableStream<Uint8Array>()), client.signal);

  expect(turns.count()).toBe(0);
  expect(response.status).toBe(499);
  expect(response.body).toBeNull();
});

test("a real HTTP peer disconnect releases a streaming turn", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let sourceCancelled = false;
  let markSourceReady!: () => void;
  const sourceReady = new Promise<void>(resolve => { markSourceReady = resolve; });
  const server = startServer(config, {
    fetchUpstream: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
        markSourceReady();
      },
      cancel() {
        sourceCancelled = true;
      },
    })),
  });
  const port = server.port;
  if (port === undefined) throw new Error("test server did not bind a TCP port");
  const endpoint = `http://127.0.0.1:${port}`;
  const socket = createConnection({ host: "127.0.0.1", port });

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const body = JSON.stringify({ query: "disconnect lifecycle proof" });
    socket.write([
      "POST /v1/alpha/search HTTP/1.1",
      "Host: 127.0.0.1",
      "Authorization: Bearer test-codex-session",
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: keep-alive",
      "",
      body,
    ].join("\r\n"));
    await sourceReady;
    source.enqueue(new TextEncoder().encode("stream-open"));
    await new Promise<void>((resolve, reject) => {
      socket.once("data", () => resolve());
      socket.once("error", reject);
    });

    expect(await (await fetch(`${endpoint}/healthz`)).json()).toMatchObject({ active_http_turns: 1 });
    socket.destroy();

    const deadline = Date.now() + 1_000;
    let activeHttpTurns = 1;
    while (Date.now() < deadline && activeHttpTurns !== 0) {
      const health = await (await fetch(`${endpoint}/healthz`)).json() as { active_http_turns: number };
      activeHttpTurns = health.active_http_turns;
      if (activeHttpTurns !== 0) await Bun.sleep(10);
    }
    expect(activeHttpTurns).toBe(0);
    expect(sourceCancelled).toBe(true);
  } finally {
    socket.destroy();
    await server.stop(true);
  }
});

test("HTTP turn cancellation aborts the tracked request and waits for lifecycle release", async () => {
  const turns = new HttpTurnCounter();
  let observedAbort = false;
  const tracked = turns.track(signal => new Promise<Response>((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      observedAbort = true;
      reject(signal.reason);
    }, { once: true });
  }));

  await waitForTurnCount(turns, 1);
  expect(await turns.cancelAll("launcher quit")).toBe(1);
  await expect(tracked).rejects.toBe("launcher quit");
  expect(observedAbort).toBe(true);
  expect(turns.count()).toBe(0);
});

test("does not advertise the optional Claude token-count endpoint", async () => {
  const server = startServer({ ...defaultConfig("browser-only"), port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/high",
        messages: [{ role: "user", content: "Inspect the repository" }],
      }),
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  } finally {
    await server.stop(true);
  }
});

test("authenticated lifecycle control cancels orphaned browser turns", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  let cancelled = 0;
  chatGptTurnSessions.clear();
  chatGptTurnSessions.getOrCreate("orphan", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }));

  try {
    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/admin/cancel-turns`, {
      method: "POST",
      headers: { authorization: "Bearer invalid" },
    });
    expect(unauthorized.status).toBe(401);
    expect(chatGptTurnSessions.activeCount()).toBe(1);

    const response = await fetch(`http://127.0.0.1:${server.port}/admin/cancel-turns`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      cancelled_http_turns: 0,
      cancelled_browser_turns: 1,
      active_http_turns: 0,
      active_browser_turns: 0,
    });
    expect(cancelled).toBe(1);
    expect(chatGptTurnSessions.activeCount()).toBe(0);
  } finally {
    chatGptTurnSessions.clear();
    await server.stop(true);
  }
});

test("server routes Claude Messages query variants to the Anthropic error contract", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "claude-sonnet", max_tokens: 100, messages: [{ role: "user", content: "test" }] }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: { type: "invalid_request_error", message: expect.stringContaining("chatgpt-web route slug") },
    });
  } finally {
    await server.stop(true);
  }
});

test("server routes Claude gateway discovery without touching the Codex catalog upstream", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  let upstreamCalled = false;
  const server = startServer(config, {
    fetchUpstream: async () => {
      upstreamCalled = true;
      return Response.json({ models: [] });
    },
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/models?limit=1000`, {
      headers: { authorization: "Bearer codex-chatgpt-web-local" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: [
        { id: "claude-chatgpt-web-light", display_name: "ChatGPT Web — Instant" },
        { id: "claude-chatgpt-web-medium", display_name: "ChatGPT Web — Medium" },
        { id: "claude-chatgpt-web-high", display_name: "ChatGPT Web — High" },
        { id: "claude-chatgpt-web-gpt-6-sol-instant", display_name: "GPT-6 Sol Instant (Web)" },
        { id: "claude-chatgpt-web-gpt-6-sol", display_name: "GPT-6 Sol (Web)" },
        { id: "claude-chatgpt-web-gpt-5.6-sol-instant", display_name: "GPT-5.6 Sol Instant (Web)" },
        { id: "claude-chatgpt-web-gpt-5.6-sol", display_name: "GPT-5.6 Sol (Web)" },
      ],
    });
    expect(upstreamCalled).toBe(false);
  } finally {
    await server.stop(true);
  }
});

test("authenticated targeted cancellation terminates one browser trace without reopening it", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  chatGptTurnSessions.clear();
  let rejectTarget!: (error: Error) => void;
  let targetCancelled = 0;
  let otherCancelled = 0;
  const targetBrowser = new Promise<string>((_resolve, reject) => { rejectTarget = reject; });
  let releaseHelper!: () => void;
  const helperCleanup = new Promise<void>(resolve => { releaseHelper = resolve; });
  const target = chatGptTurnSessions.getOrCreate("target-key", () => ({
    mode: "read-only",
    browser: targetBrowser,
    physicalSettlement: helperCleanup,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => {
      targetCancelled += 1;
      rejectTarget(new Error("tab closed"));
    },
  }), undefined, undefined, undefined, "trace_target");
  chatGptTurnSessions.getOrCreate("other-key", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { otherCancelled += 1; },
  }), undefined, undefined, undefined, "trace_other");

  try {
    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/admin/cancel-turn`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer invalid" },
      body: JSON.stringify({ traceId: "trace_target" }),
    });
    expect(unauthorized.status).toBe(401);

    const response = await fetch(`http://127.0.0.1:${server.port}/admin/cancel-turn`, {
      method: "POST",
      signal: AbortSignal.timeout(1_000),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.controlToken}`,
      },
      body: JSON.stringify({ traceId: "trace_target" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      trace_id: "trace_target",
      cancelled_browser_turns: 1,
      cancelled_broker_turns: 0,
      // The receipt acknowledges cancellation before the browser's promise microtasks settle.
      active_browser_turns: 2,
    });
    expect(targetCancelled).toBe(1);
    expect(otherCancelled).toBe(0);
    expect(target.settledOutcome()).toMatchObject({ type: "error" });
    expect(chatGptTurnSessions.getOrCreate("target-key", () => {
      throw new Error("cancelled trace must remain terminal");
    }, undefined, undefined, undefined, "trace_target")).toBe(target);
  } finally {
    releaseHelper();
    chatGptTurnSessions.clear();
    await server.stop(true);
  }
});

test("authenticated targeted cancellation aborts a shared structured compaction owner", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  const handoffTraceId = "a1b2c3d4e5f6";
  const traceId = `${handoffTraceId}_fallback`;
  let aborted = false;
  const run = runStructuredCompactionOnce(
    `structured-${Date.now()}-${Math.random()}`,
    { ownerKey: `owner-${traceId}`, traceIds: [handoffTraceId, traceId] },
    signal => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  );

  try {
    await Bun.sleep(0);
    const response = await fetch(`http://127.0.0.1:${server.port}/admin/cancel-turn`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.controlToken}`,
      },
      body: JSON.stringify({ traceId }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      trace_id: traceId,
      cancelled_compaction_runs: 1,
    });
    await expect(run).rejects.toThrow("The ChatGPT browser tab was closed");
    expect(aborted).toBeTrue();
  } finally {
    await server.stop(true);
  }
});

test("authenticated cancel-all aborts fresh structured compaction work", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  const key = `structured-all-${Date.now()}-${Math.random()}`;
  let aborted = false;
  const run = runStructuredCompactionOnce(
    key,
    { ownerKey: `owner-${key}`, traceIds: [`trace-${key}`] },
    signal => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  );

  try {
    await Bun.sleep(0);
    const response = await fetch(`http://127.0.0.1:${server.port}/admin/cancel-turns`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      cancelled_compaction_runs: 1,
    });
    await expect(run).rejects.toThrow("Active turn cancelled by launcher");
    expect(aborted).toBeTrue();
  } finally {
    await server.stop(true);
  }
});

test.serial("authenticated account-safety control exposes status and recovery actions", async () => {
  const safetyHome = mkdtempSync(join(tmpdir(), "cgw-server-safety-"));
  const previousSafetyHome = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = safetyHome;
  const config = { ...defaultConfig("browser-only"), port: 0 } as ReturnType<typeof defaultConfig> & {
    automaticWebSessionLimitCount?: number;
    automaticWebSessionLimitMinutes?: number;
  };
  config.automaticWebSessionLimitCount = 40;
  config.automaticWebSessionLimitMinutes = 300;
  const server = startServer(config);
  try {
    const headers = { authorization: `Bearer ${config.controlToken}` };
    const status = await fetch(`http://127.0.0.1:${server.port}/admin/account-safety-status`, {
      method: "POST", headers,
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      status: "ok",
      account_safety: { state: "NORMAL", limit_minutes: 300, used_sessions: 0, session_limit: 40 },
    });

    chatGptAccountSafety().admit("trace-a", "session-a", 40, 300, [], Date.now());
    const reset = await fetch(`http://127.0.0.1:${server.port}/admin/account-safety-reset-usage`, {
      method: "POST", headers,
    });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({
      status: "ok",
      account_safety: { state: "NORMAL", used_sessions: 0, session_limit: 40 },
    });

    chatGptAccountSafety().trigger("rate_limit", []);
    const resumed = await fetch(`http://127.0.0.1:${server.port}/admin/account-safety-resume`, {
      method: "POST", headers,
    });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ status: "ok", account_safety: { state: "NORMAL" } });
  } finally {
    await server.stop(true);
    if (previousSafetyHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previousSafetyHome;
    rmSync(safetyHome, { recursive: true, force: true });
  }
});

test.serial("idle drain blocks stale safety writes and reloads external usage before resume", async () => {
  const safetyHome = mkdtempSync(join(tmpdir(), "cgw-server-safety-sync-"));
  const previous = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = safetyHome;
  const config = { ...defaultConfig("browser-only"), port: 0, automaticWebSessionLimitCount: 6,
    automaticWebSessionLimitMinutes: 300 };
  const server = startServer(config);
  const endpoint = `http://127.0.0.1:${server.port}`;
  const headers = { authorization: `Bearer ${config.controlToken}` };
  const owner = "a".repeat(64);
  const ownedHeaders = { ...headers, "x-account-safety-drain-owner": owner };
  try {
    const drain = await fetch(`${endpoint}/admin/drain-if-idle`, { method: "POST", headers: ownedHeaders });
    expect(await drain.json()).toMatchObject({ acquired: true, accepting_turns: false });
    expect((await fetch(`${endpoint}/admin/drain-if-idle`, { method: "POST", headers })).status).toBe(409);
    expect((await fetch(`${endpoint}/admin/resume`, { method: "POST", headers })).status).toBe(409);
    expect((await fetch(`${endpoint}/admin/drain`, { method: "POST", headers })).status).toBe(409);
    expect((await fetch(`${endpoint}/admin/shutdown`, { method: "POST", headers })).status).toBe(409);
    expect((await fetch(`${endpoint}/admin/account-safety-status`, { method: "POST", headers })).status).toBe(503);
    const external = new ChatGptAccountSafety(join(safetyHome, "runtime", "account-safety.json"));
    expect(external.admit("pi", "pi", 6, 300, []).allowed).toBe(true);
    const unauthorized = await fetch(`${endpoint}/admin/account-safety-sync-and-resume`, { method: "POST" });
    expect(unauthorized.status).toBe(401);
    expect((await fetch(`${endpoint}/admin/account-safety-sync-and-resume`, { method: "POST", headers })).status).toBe(409);
    const resumed = await fetch(`${endpoint}/admin/account-safety-sync-and-resume`, { method: "POST", headers: ownedHeaders });
    expect(await resumed.json()).toMatchObject({ status: "ok", accepting_turns: true });
    expect(chatGptAccountSafety().status(6, 300, []).usedSessions).toBe(1);
    expect(new ChatGptAccountSafety(join(safetyHome, "runtime", "account-safety.json"))
      .status(6, 300, []).usedSessions).toBe(1);
  } finally {
    await server.stop(true);
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previous;
    rmSync(safetyHome, { recursive: true, force: true });
  }
});

test("a Codex retry after tab cancellation receives terminal HTTP 400 without a new browser", async () => {
  const config = defaultConfig("browser-only");
  const turnId = "turn_cancelled_replay";
  const body = {
    model: "chatgpt-web/high",
    stream: true,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: "thread_cancelled_replay",
        turn_id: turnId,
      }),
    },
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Run until the browser tab is closed" }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    }],
  };
  const parsed = parseRequest(body);
  routeChatGptWebRequest(parsed, config);
  const traceId = chatGptWebTraceId(providerConfig(config), parsed);
  let rejectBrowser!: (error: Error) => void;
  chatGptTurnSessions.clear();
  chatGptTurnSessions.getOrCreate("cancelled-replay", () => ({
    mode: "read-only",
    browser: new Promise<string>((_resolve, reject) => { rejectBrowser = reject; }),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: reason => rejectBrowser(reason ?? new Error("cancelled")),
  }), undefined, undefined, undefined, traceId);

  try {
    expect(await chatGptTurnSessions.cancelTrace(traceId)).toBe(1);
    expect(chatGptTurnSessions.cancelledError(traceId)?.message).toContain("Codex turn was cancelled");
    let adapterConstructions = 0;
    const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }), config, () => {
      adapterConstructions += 1;
      throw new Error("cancelled turn must not construct a new browser adapter");
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        type: "client_closed_request",
        code: "client_cancelled",
        message: "The ChatGPT browser tab was closed, so the Codex turn was cancelled.",
      },
    });
    expect(adapterConstructions).toBe(0);
  } finally {
    chatGptTurnSessions.clear();
  }
});

test("a restart recovery turn without a new user instruction fails terminally instead of replaying the stopped prompt", async () => {
  const config = defaultConfig("browser-only");
  const previousTurnId = "turn_before_codex_restart";
  const recoveryTurnId = "turn_after_codex_restart";
  const body = {
    model: "chatgpt-web/high",
    stream: true,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: "thread_codex_restart",
        turn_id: recoveryTurnId,
      }),
    },
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Run the original task" }],
        internal_chat_message_metadata_passthrough: { turn_id: previousTurnId },
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "<skills_instructions>fresh skills</skills_instructions>" }],
        internal_chat_message_metadata_passthrough: { turn_id: recoveryTurnId },
      },
    ],
  };
  let adapterConstructions = 0;

  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), config, () => {
    adapterConstructions += 1;
    throw new Error("a context-only recovery turn must not construct a browser adapter");
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: {
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: "ChatGPT web current user message conflicts with native Codex turn_id metadata",
    },
  });
  expect(adapterConstructions).toBe(0);
});

test.each(["alpha/search", "images/generations"])("authenticated lifecycle control aborts active %s before acknowledging cancellation", async path => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  let upstreamAbortObserved = false;
  const server = startServer(config, {
    fetchUpstream: request => new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => {
        upstreamAbortObserved = true;
        reject(request.signal.reason);
      }, { once: true });
    }),
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const activeRequest = fetch(`${endpoint}/v1/${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-codex-session",
      "content-type": "application/json",
    },
    body: JSON.stringify(path === "alpha/search"
      ? { query: "retained turn" }
      : { model: "gpt-image-1", prompt: "A blue square" }),
  }).catch(() => null);

  try {
    const deadline = Date.now() + 1_000;
    let activeHttpTurns = 0;
    while (Date.now() < deadline && activeHttpTurns !== 1) {
      const health = await (await fetch(`${endpoint}/healthz`)).json() as { active_http_turns: number };
      activeHttpTurns = health.active_http_turns;
      if (activeHttpTurns !== 1) await Bun.sleep(5);
    }
    expect(activeHttpTurns).toBe(1);

    const cancelled = await fetch(`${endpoint}/admin/cancel-turns`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
    });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({
      status: "ok",
      cancelled_http_turns: 1,
      active_http_turns: 0,
      active_browser_turns: 0,
    });
    expect(upstreamAbortObserved).toBe(true);
    await activeRequest;
  } finally {
    await server.stop(true);
  }
});

test("a full-mode runtime exposes its broker endpoint before any turn registers", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-serve-"));
  // The endpoint is a Unix socket on POSIX and a named pipe on Windows, so liveness is proven by
  // the broker answering its own protocol, never by a path existing.
  const config = { ...defaultConfig("full"), port: 0, brokerSocketPath: defaultBrokerEndpoint(root) };
  const server = startServer(config);
  try {
    const deadline = Date.now() + 5_000;
    let message = "";
    for (;;) {
      try {
        await callTurnBroker(config.brokerSocketPath, { method: "claim", token: "not-a-registered-turn" });
        message = "";
        break;
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      // An in-flight ChatGPT turn calls the bridge from a separate process; it must reach the
      // broker itself rather than an endpoint that no longer exists.
      if (!message.includes("unavailable") || Date.now() >= deadline) break;
      await Bun.sleep(20);
    }
    expect(message).toContain("turn token is invalid");
  } finally {
    await server.stop(true);
    await closeTurnBrokers();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lifecycle drain and cancellation include browser turns owned by the external DEV driver", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-dev-lifecycle-"));
  const config = { ...defaultConfig("full"), port: 0, brokerSocketPath: defaultBrokerEndpoint(root) };
  await TurnBroker.forSocket(config.brokerSocketPath).listen();
  const server = startServer(config);
  const endpoint = `http://127.0.0.1:${server.port}`;
  const authorization = { authorization: `Bearer ${config.controlToken}` };
  const remote = new RemoteTurnBroker(config.brokerSocketPath);
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [],
    };
    const token = await remote.register(environment, 60_000, "dev-lifecycle");
    const waiting = remote.nextToolBatch(token).then(
      () => "resolved",
      error => error instanceof Error ? error.message : String(error),
    );

    const drain = await fetch(`${endpoint}/admin/drain`, { method: "POST", headers: authorization });
    expect(await drain.json()).toMatchObject({ active_browser_turns: 1, accepting_turns: false });
    await expect(remote.register(environment, 60_000, "dev-after-drain")).rejects.toThrow("draining");

    const cancel = await fetch(`${endpoint}/admin/cancel-turns`, { method: "POST", headers: authorization });
    expect(await cancel.json()).toMatchObject({
      cancelled_http_turns: 0,
      cancelled_browser_turns: 1,
      active_browser_turns: 0,
    });
    expect(await waiting).toContain("revoked");
  } finally {
    await server.stop(true);
    await closeTurnBrokers();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a drained runtime rejects new model-catalog work before shutdown", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  const endpoint = `http://127.0.0.1:${server.port}`;
  const authorization = { authorization: `Bearer ${config.controlToken}` };
  try {
    const drain = await fetch(`${endpoint}/admin/drain`, {
      method: "POST",
      headers: authorization,
    });
    expect(drain.status).toBe(200);

    const models = await fetch(`${endpoint}/v1/models`);
    expect(models.status).toBe(503);
    expect(await models.json()).toMatchObject({
      error: {
        type: "server_error",
        message: "codex-chatgpt-web is draining for a requested service operation",
      },
    });

    const resume = await fetch(`${endpoint}/admin/resume`, {
      method: "POST",
      headers: authorization,
    });
    expect(resume.status).toBe(200);
  } finally {
    await server.stop(true);
  }
});

test("an atomic idle drain leaves admission open while a browser turn is active", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  const endpoint = `http://127.0.0.1:${server.port}`;
  const authorization = { authorization: `Bearer ${config.controlToken}` };
  chatGptTurnSessions.clear();
  chatGptTurnSessions.getOrCreate("restart-active-turn", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => {},
  }));

  try {
    const busy = await fetch(`${endpoint}/admin/drain-if-idle`, {
      method: "POST",
      headers: authorization,
    });
    expect(busy.status).toBe(200);
    expect(await busy.json()).toMatchObject({
      status: "busy",
      acquired: false,
      accepting_turns: true,
      active_http_turns: 0,
      active_browser_turns: 1,
    });
    expect(await (await fetch(`${endpoint}/healthz`)).json()).toMatchObject({
      accepting_turns: true,
      active_browser_turns: 1,
    });

    chatGptTurnSessions.clear();
    const drained = await fetch(`${endpoint}/admin/drain-if-idle`, {
      method: "POST",
      headers: authorization,
    });
    expect(drained.status).toBe(200);
    expect(await drained.json()).toMatchObject({
      status: "ok",
      acquired: true,
      accepting_turns: false,
      active_http_turns: 0,
      active_browser_turns: 0,
    });
  } finally {
    chatGptTurnSessions.clear();
    await server.stop(true);
  }
});

test("health proves that Codex received a successful augmented model catalog", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config, {
    fetchUpstream: async () => Response.json({
      models: [{
        slug: "gpt-5.6-sol",
        display_name: "5.6 Sol",
        visibility: "list",
        supported_in_api: true,
        supported_reasoning_levels: [],
        tool_mode: "code_mode_only",
      }],
    }),
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  try {
    expect(await (await fetch(`${endpoint}/healthz`)).json()).toMatchObject({
      successful_model_catalog_requests: 0,
      last_successful_model_catalog_request_at: null,
    });

    const models = await fetch(`${endpoint}/v1/models`, {
      headers: { authorization: "Bearer test-codex-session" },
    });
    expect(models.status).toBe(200);

    const health = await (await fetch(`${endpoint}/healthz`)).json() as Record<string, unknown>;
    expect(health.successful_model_catalog_requests).toBe(1);
    expect(typeof health.last_successful_model_catalog_request_at).toBe("string");
  } finally {
    await server.stop(true);
  }
});

test("server exposes authenticated standalone Web Search on the routed v1 base URL", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  let upstreamRequest: Request | undefined;
  const server = startServer(config, {
    fetchUpstream: async request => {
      upstreamRequest = request;
      return Response.json({ results: ["native-search-result"] });
    },
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  try {
    const response = await fetch(`${endpoint}/v1/alpha/search`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-codex-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "bridge route" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: ["native-search-result"] });
    expect(upstreamRequest!.url).toBe("https://chatgpt.com/backend-api/codex/alpha/search");
    expect(upstreamRequest!.headers.get("authorization")).toBe("Bearer test-codex-session");
    expect(await upstreamRequest!.json()).toEqual({ query: "bridge route" });
  } finally {
    await server.stop(true);
  }
});

test("standalone native image generation and edits preserve their upstream protocol", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const requests: Request[] = [];
  const reply = '{ "created": 1778832973, "data": [{ "b64_json": "native-image-bytes" }] }';
  const denied = '{ "error": { "code": "rate_limit_exceeded", "message": "Image allowance reached" } }';
  const upstreamServer = Bun.serve({
    port: 0,
    fetch: request => {
      const edit = new URL(request.url).pathname.endsWith("/edits");
      return new Response(Bun.gzipSync(edit ? denied : reply), {
        status: edit ? 429 : 200,
        headers: {
          "content-type": "application/json", "content-encoding": "gzip",
          "x-codex-imagegen-request-id": "native-image-request",
        },
      });
    },
  });
  const server = startServer(config, {
    fetchUpstream: async request => {
      requests.push(request);
      const path = new URL(request.url).pathname;
      return fetch(new Request(`http://127.0.0.1:${upstreamServer.port}${path}`, request.clone()));
    },
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  try {
    for (const operation of ["generations", "edits"] as const) {
      const body = operation === "generations"
        ? '{ "model": "gpt-image-1", "prompt": "A blue square", "n": 1 }'
        : '{ "model": "gpt-image-1", "prompt": "Make it green", "images": [{ "image_url": "data:image/png;base64,AAAA" }] }';
      const response = await fetch(`${endpoint}/v1/images/${operation}?fixture=1`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-codex-session",
          "content-type": "application/json",
          "chatgpt-account-id": "test-account",
          "x-codex-image-turn-id": "native-image-turn",
        },
        body,
      });
      expect(response.status).toBe(operation === "generations" ? 200 : 429);
      expect(await response.text()).toBe(operation === "generations" ? reply : denied);
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("x-codex-imagegen-request-id")).toBe("native-image-request");
      const upstream = requests.at(-1)!;
      expect(upstream.url).toBe(`https://chatgpt.com/backend-api/codex/images/${operation}?fixture=1`);
      expect(upstream.method).toBe("POST");
      expect(upstream.redirect).toBe("manual");
      expect(upstream.headers.get("authorization")).toBe("Bearer test-codex-session");
      expect(upstream.headers.get("chatgpt-account-id")).toBe("test-account");
      expect(upstream.headers.get("x-codex-image-turn-id")).toBe("native-image-turn");
      expect(upstream.headers.get("host")).toBeNull();
      expect(await upstream.text()).toBe(body);
    }
    expect(requests).toHaveLength(2);
    const unauthorized = await fetch(`${endpoint}/v1/images/generations`, { method: "POST", body: "{}" });
    expect(unauthorized.status).toBe(401);
    expect(requests).toHaveLength(2);
    await fetch(`${endpoint}/admin/drain`, {
      method: "POST", headers: { authorization: `Bearer ${config.controlToken}` },
    });
    const drained = await fetch(`${endpoint}/v1/images/edits`, {
      method: "POST", headers: { authorization: "Bearer test-codex-session" }, body: "{}",
    });
    expect(drained.status).toBe(503);
    expect(requests).toHaveLength(2);
  } finally {
    await server.stop(true);
    await upstreamServer.stop(true);
  }
});

test("authenticated shutdown requires a verified idle drain", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  const endpoint = `http://127.0.0.1:${server.port}`;
  const authorization = { authorization: `Bearer ${config.controlToken}` };

  try {
    const unauthorized = await fetch(`${endpoint}/admin/shutdown`, {
      method: "POST",
      headers: { authorization: "Bearer invalid" },
    });
    expect(unauthorized.status).toBe(401);

    const undrained = await fetch(`${endpoint}/admin/shutdown`, {
      method: "POST",
      headers: authorization,
    });
    expect(undrained.status).toBe(409);

    const drain = await fetch(`${endpoint}/admin/drain`, {
      method: "POST",
      headers: authorization,
    });
    expect(drain.status).toBe(200);

    const shutdown = await fetch(`${endpoint}/admin/shutdown`, {
      method: "POST",
      headers: authorization,
    });
    expect(shutdown.status).toBe(200);
    expect(await shutdown.json()).toMatchObject({
      status: "ok",
      accepting_turns: false,
      active_http_turns: 0,
      active_browser_turns: 0,
    });

    const deadline = Date.now() + 2_000;
    let stopped = false;
    while (Date.now() < deadline && !stopped) {
      await Bun.sleep(20);
      try {
        await fetch(`${endpoint}/healthz`);
      } catch {
        stopped = true;
      }
    }
    expect(stopped).toBe(true);
  } finally {
    await server.stop(true);
  }
});

test("Luna Bigger Context reaches the adapter for every Free route and response mode", async () => {
  for (const mode of ["browser-only", "full"] as const) for (const stream of [false, true]) {
    for (const model of ["chatgpt-web/gpt-5.6-luna", "chatgpt-web/luna", "chatgpt-web/think"]) {
      const config = { ...defaultConfig(mode), solAvailable: false, experimentalBiggerContext: true };
      let adapterStarted = false;
      const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: "hello", stream }),
      }), config, () => ({
        name: "luna-bigger-context-test",
        async runTurn(parsed, _incoming, emit) {
          adapterStarted = true;
          expect(parsed.modelId).toBe("gpt-5.6-luna");
          emit({ type: "text_delta", text: "ready", phase: "final_answer" });
          emit({ type: "done", stopReason: "stop", endTurn: true,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: true } });
        },
      }));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("ready");
      expect(adapterStarted).toBeTrue();
    }
  }
});


test("a cancelled model request does not replace health from the last completed request", async () => {
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let abortObserved!: () => void;
  const aborted = new Promise<void>(resolve => { abortObserved = resolve; });
  let pending = false;
  const server = startServer({ ...defaultConfig("browser-only"), port: 0 }, {
    // An abandoned upstream attempt is normally kept for the client's retry (#696).
    modelCatalogFetches: new ModelCatalogFetches(0),
    fetchUpstream: async request => {
      if (!pending) return new Response("Denied", { status: 403 });
      entered();
      return await new Promise<Response>((_resolve, reject) => {
        const cancel = () => { abortObserved(); reject(new DOMException("cancel", "AbortError")); };
        if (request.signal.aborted) cancel();
        else request.signal.addEventListener("abort", cancel, { once: true });
      });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { authorization: "Bearer fixture" };
  const health = async () => await (await fetch(`${base}/healthz`)).json() as Record<string, any>;
  try {
    await (await fetch(`${base}/v1/models`, { headers })).text();
    const before = (await health()).last_model_catalog_result;
    pending = true;
    const controller = new AbortController();
    const request = fetch(`${base}/v1/models`, { headers, signal: controller.signal }).catch(() => undefined);
    await ready;
    controller.abort();
    await request;
    await aborted;
    const after = await health();
    expect(after.last_model_catalog_result).toEqual(before);
    expect(after.successful_model_catalog_requests).toBe(0);
    expect(after.model_catalog_requests).toBe(2);
  } finally { await server.stop(true); }
});

// The security model treats websites as untrusted, yet any page can POST to a loopback port
// (cross-site, or same-origin after DNS rebinding). Browsers attach Origin to those requests.
test("a web page cannot start or control turns through the loopback route", async () => {
  let adapterTurns = 0;
  const server = startServer({ ...defaultConfig("browser-only"), port: 0, solAvailable: false }, {
    adapterFactory: () => ({
      name: "browser-origin-test",
      async runTurn(_parsed, _incoming, emit) {
        adapterTurns += 1;
        emit({ type: "text_delta", text: "ready", phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: true } });
      },
    }),
  });
  const base = `http://127.0.0.1:${server.port}`;
  const body = JSON.stringify({ model: "chatgpt-web/gpt-5.6-luna", input: "hello", stream: false });
  try {
    for (const origin of ["https://attacker.example", `http://rebound.example:${server.port}`, "null"]) {
      for (const path of ["/v1/responses", "/v1/responses/compact", "/v1/alpha/search", "/admin/cancel-turns"]) {
        // A no-cors page can only send a simple content type; the JSON body is parsed regardless.
        const response = await fetch(`${base}${path}`, {
          method: "POST", headers: { origin, "content-type": "text/plain" }, body,
        });
        expect(response.status).toBe(403);
        expect(await response.text()).toBe("Forbidden");
      }
    }
    expect(adapterTurns).toBe(0);

    // Codex and the launcher are not browsers: their requests carry no Origin and are unchanged.
    const native = await fetch(`${base}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    expect(native.status).toBe(200);
    expect(await native.text()).toContain("ready");
    expect(adapterTurns).toBe(1);
    // Read-only negotiation and health stay reachable so transport selection is unaffected.
    expect((await fetch(`${base}/v1/responses`, { headers: { origin: "https://attacker.example" } })).status).toBe(426);
    expect((await fetch(`${base}/healthz`, { headers: { origin: "https://attacker.example" } })).status).toBe(200);
  } finally {
    await server.stop(true);
  }
});

// #696: Codex abandons a catalog request after five seconds and retries. On a network whose first
// HTTPS connection takes longer, cancelling upstream with each attempt made every retry start over.
test("a catalog request that outlives the client's deadline completes for its retry", async () => {
  let upstreamCalls = 0;
  let upstreamAborts = 0;
  const server = startServer({ ...defaultConfig("browser-only"), port: 0 }, {
    fetchUpstream: async request => {
      upstreamCalls += 1;
      await new Promise<void>((resolve, reject) => {
        const connected = setTimeout(resolve, 400);
        request.signal.addEventListener("abort", () => {
          upstreamAborts += 1;
          clearTimeout(connected);
          reject(new DOMException("cancel", "AbortError"));
        }, { once: true });
      });
      return Response.json({ models: [{ slug: "native", visibility: "list", supported_reasoning_levels: [] }] });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const attempt = async (): Promise<number | "abandoned"> => {
    try {
      const response = await fetch(`${base}/v1/models?client_version=1.2.3`, {
        headers: { authorization: "Bearer fixture" }, signal: AbortSignal.timeout(150),
      });
      await response.text();
      return response.status;
    } catch {
      return "abandoned";
    }
  };
  try {
    const attempts: Array<number | "abandoned"> = [];
    while (attempts.length < 6 && attempts.at(-1) !== 200) attempts.push(await attempt());
    expect(attempts.at(-1)).toBe(200);
    expect(attempts.slice(0, -1).every(result => result === "abandoned")).toBeTrue();
    // Before the fix every abandoned attempt cancelled and restarted its own upstream request.
    expect(upstreamAborts).toBe(0);
    expect(upstreamCalls).toBeLessThan(attempts.length);
    const health = await (await fetch(`${base}/healthz`)).json() as Record<string, any>;
    expect(health.successful_model_catalog_requests).toBe(1);
    expect(health.last_model_catalog_result).toMatchObject({ status: 200 });
  } finally {
    await server.stop(true);
  }
});

test("shared catalog attempts stay bound to one request identity and are final once delivered", async () => {
  const catalog = { models: [{ slug: "native", visibility: "list", supported_reasoning_levels: [] }] };
  const upstream: Array<{ authorization: string | null; aborted: boolean; respond: (response: Response) => void }> = [];
  const server = startServer({ ...defaultConfig("browser-only"), port: 0 }, {
    fetchUpstream: request => new Promise<Response>((resolve, reject) => {
      const call = { authorization: request.headers.get("authorization"), aborted: false, respond: resolve };
      upstream.push(call);
      request.signal.addEventListener("abort", () => {
        call.aborted = true;
        reject(new DOMException("cancel", "AbortError"));
      }, { once: true });
    }),
  });
  const base = `http://127.0.0.1:${server.port}`;
  const get = (token: string, signal?: AbortSignal) => fetch(`${base}/v1/models`, {
    headers: { authorization: `Bearer ${token}` }, ...(signal ? { signal } : {}),
  });
  // A request is counted in the same tick in which it joins or starts its upstream attempt.
  const received = async (count: number) => {
    for (let waited = 0; waited < 2_000; waited += 5) {
      const health = await (await fetch(`${base}/healthz`)).json() as { model_catalog_requests: number };
      if (health.model_catalog_requests >= count) return;
      await Bun.sleep(5);
    }
    throw new Error(`Expected ${count} catalog requests`);
  };
  try {
    // Identical concurrent requests share one attempt; another account never does.
    const [first, second, other] = [get("account-a"), get("account-a"), get("account-b")];
    await received(3);
    expect(upstream.map(call => call.authorization).sort()).toEqual(["Bearer account-a", "Bearer account-b"]);
    upstream.find(call => call.authorization === "Bearer account-b")!.respond(new Response("Denied", { status: 403 }));
    upstream.find(call => call.authorization === "Bearer account-a")!.respond(Response.json(catalog));
    expect([(await first).status, (await second).status, (await other).status]).toEqual([200, 200, 403]);

    // A delivered result and a failure are both final: the next request asks upstream again.
    const repeated = get("account-b");
    await received(4);
    expect(upstream.length).toBe(3);
    upstream[2]!.respond(Response.json(catalog));
    expect((await repeated).status).toBe(200);
  } finally {
    await server.stop(true);
  }
});

test("an abandoned catalog attempt serves the retry once and is cancelled when nobody returns", async () => {
  const fetches = new ModelCatalogFetches(40, 500);
  const upstream: Array<{ signal: AbortSignal; respond: () => void }> = [];
  const forward = (request: Request, markSent: () => void) => new Promise<Response>((resolve, reject) => {
    markSent();
    upstream.push({ signal: request.signal, respond: () => resolve(Response.json({ models: [] })) });
    request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
  });
  const request = (signal?: AbortSignal) => new Request("http://127.0.0.1/v1/models", {
    headers: { authorization: "Bearer fixture" }, ...(signal ? { signal } : {}),
  });
  const abandon = async () => {
    const client = new AbortController();
    const waiting = fetches.fetch(request(client.signal), forward);
    client.abort();
    expect(await waiting).toMatchObject({ ok: false, sent: true });
  };
  try {
    // The client gives up; its upstream attempt keeps running and the retry joins it.
    await abandon();
    expect(upstream.length).toBe(1);
    expect(upstream[0]!.signal.aborted).toBeFalse();
    const retry = fetches.fetch(request(), forward);
    upstream[0]!.respond();
    expect(await retry).toMatchObject({ ok: true, status: 200 });
    expect(upstream.length).toBe(1);

    // Completed with nobody waiting: the next request takes that result once, then asks again.
    await abandon();
    upstream[1]!.respond();
    await Bun.sleep(5);
    expect(await fetches.fetch(request(), forward)).toMatchObject({ ok: true, status: 200 });
    expect(upstream.length).toBe(2);
    const fresh = fetches.fetch(request(), forward);
    expect(upstream.length).toBe(3);
    upstream[2]!.respond();
    expect(await fresh).toMatchObject({ ok: true });

    // Nobody returns: the attempt is cancelled, and a later request starts a new one.
    await abandon();
    await Bun.sleep(120);
    expect(upstream[3]!.signal.aborted).toBeTrue();
    const later = fetches.fetch(request(), forward);
    expect(upstream.length).toBe(5);
    upstream[4]!.respond();
    expect(await later).toMatchObject({ ok: true });
    expect(upstream.filter(call => call.signal.aborted).length).toBe(1);
  } finally {
    fetches.close();
  }
});
