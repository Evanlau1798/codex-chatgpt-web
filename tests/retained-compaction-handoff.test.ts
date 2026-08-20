import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPACTION_HANDOFF_MARKER } from "../src/adapters/chatgpt-web/compaction-handoff";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { requestRetainedCompactionHandoff } from "../src/adapters/chatgpt-web/retained-compaction-handoff";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession, chatGptConversationKey } from "../src/adapters/chatgpt-web/turn-execution";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import type { CodexParsedRequest } from "../src/types";

function request(compaction = false): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    context: { messages: [{ role: "user", content: "Inspect the project", timestamp: 1 }] },
    options: { reasoning: "high" },
    _compactionRequest: compaction,
    _rawBody: {
      prompt_cache_key: "thread_retained_compact",
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({
        thread_id: "thread_retained_compact", turn_id: compaction ? "turn_compact" : "turn_source",
      }) },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the project" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_source" } }],
    },
  };
}

test("retained Enhanced compact ignores marker-only Web finals and keeps the Native2 control connector", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-retained-marker-only-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const namespace = createHash("sha256").update("retained-compact-test").digest("hex");
  const sourceRequest = request(false);
  const source = new ChatGptTurnSession({
    mode: "read-only", browser: Promise.resolve("done"), trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(), usageInput: sourceRequest, cancel: () => {},
  });
  let turn: BrowserTurn | undefined;
  const worker = { run: async (value: BrowserTurn) => {
    turn = value;
    return `${COMPACTION_HANDOFF_MARKER}\nThe retained Web Agent preserved the completed turn.`;
  } };
  try {
    const handoff = await requestRetainedCompactionHandoff(
      worker as never,
      request(true),
      source,
      broker,
      namespace,
      { localToolsEnabled: true, solAvailable: true, proAvailable: true },
      "trace12345678",
      undefined,
      20,
    );

    expect(handoff).toBeUndefined();
    expect(turn?.conversationKey).toBe(chatGptConversationKey(sourceRequest, namespace));
    expect(turn?.requireRetainedConversation).toBeTrue();
    expect(turn?.nativeConnector).toBeTrue();
    expect(turn?.capabilities.localToolsEnabled).toBeFalse();
    const prepared = await turn!.prepare();
    expect(prepared.text).toContain("codex.control.compaction_handoff");
    expect(prepared.text).not.toContain(COMPACTION_HANDOFF_MARKER);
    expect(prepared.text).not.toContain("Inspect the project");
    prepared.release();
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retained Enhanced compact releases a failed checkpoint browser run before the same-trace retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-retained-retry-cleanup-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const namespace = createHash("sha256").update("retained-compact-retry-test").digest("hex");
  const source = new ChatGptTurnSession({
    mode: "read-only", browser: Promise.resolve("done"), trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(), usageInput: request(false), cancel: () => {},
  });
  const active = new Set<string>();
  let starts = 0;
  const worker = { run: (turn: BrowserTurn) => {
    if (active.has(turn.traceId)) {
      return Promise.reject(new Error(`Duplicate ChatGPT web browser turn: ${turn.traceId}`));
    }
    active.add(turn.traceId);
    starts += 1;
    return new Promise<string>((_resolve, reject) => {
      const abort = () => setTimeout(() => {
        active.delete(turn.traceId);
        reject(new DOMException("checkpoint browser run aborted", "AbortError"));
      }, 5);
      if (turn.abortSignal?.aborted) abort();
      else turn.abortSignal?.addEventListener("abort", abort, { once: true });
    });
  } };
  const compact = () => requestRetainedCompactionHandoff(
    worker as never,
    request(true),
    source,
    broker,
    namespace,
    { localToolsEnabled: true, solAvailable: true, proAvailable: true },
    "retrytrace12",
    undefined,
    20,
  );

  try {
    expect(await compact()).toBeUndefined();
    expect(active.size).toBe(0);
    expect(await compact()).toBeUndefined();
    expect(starts).toBe(2);
    expect(active.size).toBe(0);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retained Enhanced compact cleanup stays bounded when the browser ignores abort", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-retained-bounded-cleanup-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const namespace = createHash("sha256").update("retained-compact-bounded-cleanup-test").digest("hex");
  const source = new ChatGptTurnSession({
    mode: "read-only", browser: Promise.resolve("done"), trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(), usageInput: request(false), cancel: () => {},
  });
  const worker = { run: (_turn: BrowserTurn) => new Promise<string>(() => {}) };
  const startedAt = performance.now();

  try {
    const handoff = await Promise.race([requestRetainedCompactionHandoff(
      worker as never,
      request(true),
      source,
      broker,
      namespace,
      { localToolsEnabled: true, solAvailable: true, proAvailable: true },
      "boundedtrace",
      undefined,
      20,
    ), Bun.sleep(200).then(() => "cleanup-timeout" as const)]);
    expect(handoff).not.toBe("cleanup-timeout");
    expect(handoff).toBeUndefined();
    expect(performance.now() - startedAt).toBeLessThan(250);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retained Enhanced compact stays bounded after structured handoff when the browser never completes", async () => {
  const namespace = createHash("sha256").update("retained-compact-structured-timeout-test").digest("hex");
  const source = new ChatGptTurnSession({
    mode: "read-only", browser: Promise.resolve("done"), trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(), usageInput: request(false), cancel: () => {},
  });
  const worker = { run: (_turn: BrowserTurn) => new Promise<string>(() => {}) };
  const broker = {
    beginCompactionTransaction: async () => ({
      token: "control_11111111111111111111111111111111",
      handoffId: "handoff_22222222222222222222222222222222",
    }),
    waitForCompactionHandoff: async () => "Structured retained checkpoint is valid.",
    abortCompactionTransaction: () => {},
  } as unknown as TurnBroker;

  const handoff = await Promise.race([requestRetainedCompactionHandoff(
    worker as never,
    request(true),
    source,
    broker,
    namespace,
    { localToolsEnabled: true, solAvailable: true, proAvailable: true },
    "structuredtimeout",
    undefined,
    20,
  ), Bun.sleep(200).then(() => "browser-timeout" as const)]);

  expect(handoff).not.toBe("browser-timeout");
  expect(handoff).toBeUndefined();
});
