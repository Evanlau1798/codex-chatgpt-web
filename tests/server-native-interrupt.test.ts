import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatGptWebTraceId } from "../src/adapters/chatgpt-web";
import { runStructuredCompactionOnce } from "../src/adapters/chatgpt-web/compaction-handoff";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, closeTurnBrokers, RemoteTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint, defaultConfig, providerConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { compactRequest, HttpTurnCounter, responseRequest, routeChatGptWebRequest, startServer } from "../src/server";

async function waitForTurnCount(turns: HttpTurnCounter, expected: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (turns.count() !== expected && Date.now() < deadline) await Bun.sleep(5);
  expect(turns.count()).toBe(expected);
}

test("native Codex interrupt cancels only HTTP streams owned by the exact thread and turn", async () => {
  const turns = new HttpTurnCounter();
  const started: Promise<Response>[] = [];
  const aborted: string[] = [];
  for (const identity of [
    { threadId: "thread_exact", turnId: "turn_exact" },
    { threadId: "thread_other", turnId: "turn_other" },
  ]) {
    started.push(turns.track((signal, bindIdentity) => {
      bindIdentity(identity);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted.push(identity.turnId);
          reject(signal.reason);
        }, { once: true });
      });
    }));
  }
  await waitForTurnCount(turns, 2);

  expect(await turns.cancelTurn({ threadId: "thread_exact", turnId: "turn_exact" })).toBe(1);
  expect(aborted).toEqual(["turn_exact"]);
  expect(turns.count()).toBe(1);
  await expect(started[0]!).rejects.toHaveProperty("name", "AbortError");

  expect(await turns.cancelAll()).toBe(1);
  await expect(started[1]!).rejects.toThrow("Active HTTP turns cancelled");
});

test("native Codex interrupt remains authoritative when it arrives before HTTP identity binding", async () => {
  const turns = new HttpTurnCounter();
  const identity = { threadId: "thread_interrupt_race", turnId: "turn_interrupt_race" };
  let bind!: () => void;
  const mayBind = new Promise<void>(resolve => { bind = resolve; });
  let observedAbort = false;
  const response = turns.track(async (signal, bindIdentity) => {
    await mayBind;
    bindIdentity(identity);
    observedAbort = signal.aborted;
    return new Response(new ReadableStream<Uint8Array>());
  });
  await waitForTurnCount(turns, 1);

  expect(await turns.cancelTurn(identity)).toBe(0);
  bind();
  expect((await response).status).toBe(499);
  expect(observedAbort).toBeTrue();
  await waitForTurnCount(turns, 0);
});

test("native passthrough response and compaction requests expose their exact interrupt identity", async () => {
  const config = defaultConfig("browser-only");
  const responseIdentity = { threadId: "thread_native_response", turnId: "turn_native_response" };
  let boundResponseIdentity: typeof responseIdentity | undefined;
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: responseIdentity.threadId,
          turn_id: responseIdentity.turnId,
        }),
      },
      input: [],
    }),
  }), config, undefined, {
    onTurnIdentity: identity => { boundResponseIdentity = identity; },
  });
  expect(boundResponseIdentity).toEqual(responseIdentity);
  expect(response.status).toBe(502);

  const compactIdentity = { threadId: "thread_native_compact", turnId: "turn_native_compact" };
  let boundCompactIdentity: typeof compactIdentity | undefined;
  const compact = await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: compactIdentity.threadId,
        turn_id: compactIdentity.turnId,
      }),
    },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
  }), config, undefined, {
    onTurnIdentity: identity => { boundCompactIdentity = identity; },
  });
  expect(boundCompactIdentity).toEqual(compactIdentity);
  expect(compact.status).toBe(502);
});

test("authenticated Interrupt hook endpoint releases the exact routed Web turn", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const threadId = "thread_interrupt_hook";
  const turnId = "turn_interrupt_hook";
  let adapterAborted = false;
  let browserAborted = false;
  let rejectBrowser!: (error: Error) => void;
  const browser = new Promise<string>((_resolve, reject) => { rejectBrowser = reject; });
  chatGptTurnSessions.clear();
  chatGptTurnSessions.getOrCreate("interrupt-hook-browser", () => ({
    mode: "read-only",
    nativeIdentity: { threadId, turnId },
    browser,
    physicalSettlement: browser.then(() => undefined, () => undefined),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: reason => {
      browserAborted = true;
      rejectBrowser(reason ?? new Error("native turn interrupted"));
    },
  }), undefined, undefined, undefined, "interrupt-hook-trace");
  const server = startServer(config, {
    adapterFactory: () => ({
      name: "interrupt-test",
      runTurn: (_parsed, incoming) => new Promise<void>((_resolve, reject) => {
        incoming.abortSignal!.addEventListener("abort", () => {
          adapterAborted = true;
          reject(incoming.abortSignal!.reason);
        }, { once: true });
      }),
    }),
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const response = fetch(`${endpoint}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-web/high",
      stream: true,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
      },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "wait until interrupted" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }],
    }),
  });

  try {
    const deadline = Date.now() + 1_000;
    let activeHttpTurns = 0;
    while (Date.now() < deadline && activeHttpTurns !== 1) {
      activeHttpTurns = (await (await fetch(`${endpoint}/healthz`)).json() as { active_http_turns: number }).active_http_turns;
      if (activeHttpTurns !== 1) await Bun.sleep(5);
    }
    expect(activeHttpTurns).toBe(1);

    const interrupted = await fetch(`${endpoint}/admin/interrupt-turn`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ threadId, turnId }),
    });
    expect(interrupted.status).toBe(200);
    expect(await interrupted.json()).toMatchObject({
      status: "ok",
      cancelled_http_turns: 1,
      cancelled_browser_turns: 1,
    });
    expect(adapterAborted).toBeTrue();
    expect(browserAborted).toBeTrue();
    await response;
  } finally {
    chatGptTurnSessions.clear();
    await server.stop(true);
  }
});

test("authenticated Interrupt hook endpoint also releases the exact native compaction request", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const threadId = "thread_interrupt_compact";
  const turnId = "turn_interrupt_compact";
  let adapterAborted = false;
  const server = startServer(config, {
    adapterFactory: () => ({
      name: "interrupt-compact-test",
      runTurn: (_parsed, incoming) => new Promise<void>((_resolve, reject) => {
        incoming.abortSignal!.addEventListener("abort", () => {
          adapterAborted = true;
          reject(incoming.abortSignal!.reason);
        }, { once: true });
      }),
    }),
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const compactResponse = fetch(`${endpoint}/v1/responses/compact`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
    },
    body: JSON.stringify({
      model: "chatgpt-web/high",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "compact me" }] }],
    }),
  });

  try {
    const deadline = Date.now() + 1_000;
    let activeHttpTurns = 0;
    while (Date.now() < deadline && activeHttpTurns !== 1) {
      activeHttpTurns = (await (await fetch(`${endpoint}/healthz`)).json() as { active_http_turns: number }).active_http_turns;
      if (activeHttpTurns !== 1) await Bun.sleep(5);
    }
    expect(activeHttpTurns).toBe(1);

    const interrupted = await fetch(`${endpoint}/admin/interrupt-turn`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ threadId, turnId }),
    });
    expect(interrupted.status).toBe(200);
    expect(await interrupted.json()).toMatchObject({
      status: "ok",
      cancelled_http_turns: 1,
      cancelled_browser_turns: 0,
    });
    expect(adapterAborted).toBeTrue();
    await compactResponse;
  } finally {
    await server.stop(true);
  }
});

test("Interrupt acknowledges after exact browser cancellation starts without waiting for helper teardown", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const threadId = "thread_interrupt_slow_cleanup";
  const turnId = "turn_interrupt_slow_cleanup";
  let resolvePhysical!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { resolvePhysical = resolve; });
  let cancelled = false;
  let replacementStarted = false;
  chatGptTurnSessions.clear();
  chatGptTurnSessions.getOrCreate("slow-cleanup", () => ({
    mode: "read-only",
    nativeIdentity: { threadId, turnId },
    browser: new Promise<string>(() => {}),
    physicalSettlement,
    conversationKey: "slow-cleanup-owner",
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled = true; },
  }), undefined, undefined, undefined, "slow-cleanup-trace");
  const server = startServer(config);

  try {
    const interrupted = await Promise.race([
      fetch(`http://127.0.0.1:${server.port}/admin/interrupt-turn`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.controlToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ threadId, turnId }),
      }),
      Bun.sleep(250).then(() => undefined),
    ]);
    expect(interrupted).toBeInstanceOf(Response);
    expect(await interrupted!.json()).toMatchObject({
      status: "ok",
      cancelled_browser_turns: 1,
    });
    expect(cancelled).toBeTrue();

    const replacement = chatGptTurnSessions.getOrCreateAfterConversationRetirement(
      "slow-cleanup-replacement",
      "slow-cleanup-owner",
      () => {
        replacementStarted = true;
        return {
          mode: "read-only",
    nativeIdentity: { threadId, turnId },
          browser: Promise.resolve("replacement"),
          physicalSettlement: Promise.resolve(),
          trace: new ChatGptTraceFeed(),
          text: new ChatGptTextFeed(),
          cancel: () => {},
        };
      },
    );
    await Bun.sleep(10);
    expect(replacementStarted).toBeFalse();
    resolvePhysical();
    await replacement;
    expect(replacementStarted).toBeTrue();
  } finally {
    resolvePhysical();
    chatGptTurnSessions.clear();
    await server.stop(true);
  }
});

test("Interrupt retires a logically complete browser turn whose helper is still physically stuck", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const threadId = "thread_interrupt_logical_complete";
  const turnId = "turn_interrupt_logical_complete";
  let resolvePhysical!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { resolvePhysical = resolve; });
  let cancelled = false;
  chatGptTurnSessions.clear();
  const session = chatGptTurnSessions.getOrCreate("logical-complete", () => ({
    mode: "read-only",
    nativeIdentity: { threadId, turnId },
    browser: Promise.resolve("complete"),
    physicalSettlement,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled = true; },
  }), undefined, undefined, undefined, "logical-complete-trace");
  await session.browserOutcome;
  expect(session.isActive()).toBeFalse();
  expect(session.browserTurnPending()).toBeTrue();
  const server = startServer(config);

  try {
    const interrupted = await fetch(`http://127.0.0.1:${server.port}/admin/interrupt-turn`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ threadId, turnId }),
    });
    expect(await interrupted.json()).toMatchObject({
      status: "ok",
      cancelled_browser_turns: 1,
    });
    expect(cancelled).toBeTrue();
    expect(chatGptTurnSessions.find("logical-complete")).toBeUndefined();
  } finally {
    resolvePhysical();
    chatGptTurnSessions.clear();
    await server.stop(true);
  }
});

test("Interrupt cancels a detached structured compaction by exact native turn identity", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const threadId = "thread_interrupt_structured";
  const turnId = "turn_interrupt_structured";
  let aborted = false;
  const run = runStructuredCompactionOnce(
    `interrupt-structured-${Date.now()}-${Math.random()}`,
    {
      ownerKey: "interrupt-structured-owner",
      traceIds: ["interrupt-structured-trace"],
      nativeThreadId: threadId,
      nativeTurnId: turnId,
    },
    signal => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  );
  const server = startServer(config);

  try {
    await Bun.sleep(0);
    const interrupted = await fetch(`http://127.0.0.1:${server.port}/admin/interrupt-turn`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ threadId, turnId }),
    });
    expect(await interrupted.json()).toMatchObject({
      status: "ok",
      cancelled_compaction_runs: 1,
    });
    await expect(run).rejects.toThrow("Codex turn interrupted");
    expect(aborted).toBeTrue();

  } finally {
    await server.stop(true);
  }
});
