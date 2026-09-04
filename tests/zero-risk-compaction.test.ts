import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatGptWebAdapter, chatGptWebExecutionNamespace, type ChatGptZeroRiskManualControl } from "../src/adapters/chatgpt-web/index";
import { canonicalizeCompactionHandoff, cancelAllStructuredCompactions, cancelStructuredCompactionTrace } from "../src/adapters/chatgpt-web/compaction-handoff";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { chatGptTurnSessions, chatGptConversationKey, chatGptTurnTraceId, ChatGptTextFeed, ChatGptTraceFeed } from "../src/adapters/chatgpt-web/turn-execution";
import { deferred } from "../src/adapters/chatgpt-web/runtime-lifecycle";
import { defaultBrokerEndpoint, defaultConfig } from "../src/config";
import { compactRequest } from "../src/server";
import { LauncherBrowserTurnCancelledError, LauncherManualTurnTimedOutError } from "../src/launcher-browser-host";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

function fixture(options: { endGate?: Promise<void>; timeoutMs?: number; waitSentError?: Error; retiringSurface?: Promise<void> } = {}) {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-manual-compact-"));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  const environment = `<environment_context><cwd>${root}</cwd><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></environment_context>`;
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, stream: true, options: { reasoning: "low" },
    _compactionRequest: true,
    context: { tools: [], messages: [
      { role: "developer", content: environment, timestamp: 1 },
      { role: "user", content: "Keep the latest task intact.", timestamp: 2 },
    ] },
    _rawBody: {
      prompt_cache_key: root,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: root, turn_id: "compact" }) },
      input: [environment, "Keep the latest task intact."].map(text => ({ type: "message", role: "user",
        content: [{ type: "input_text", text }], internal_chat_message_metadata_passthrough: { turn_id: "compact" } })),
    },
  };
  let requestId = "";
  let starts = 0;
  let traceId = "";
  const started = deferred<void>();
  const restarted = deferred<void>();
  const ending = deferred<void>();
  const retiring = deferred<void>();
  const ended: string[] = [];
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) {
      starts++;
      traceId = activity.traceId;
      requestId = JSON.parse(activity.prompt.match(/<codex_zero_risk_request_json>\n([^\n]+)/)![1]!).request_id;
    },
    async waitSent() { if (options.waitSentError) throw options.waitSentError; },
    waitTerminal() { broker.startSafeTurn(requestId); return new Promise<never>(() => {}); },
    async markStarted() { (starts === 1 ? started : restarted).resolve(); },
    async end(_path, activity) { ended.push(activity.status); ending.resolve(); await options.endGate; }, async cancel() {},
  };
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: `manual://${root}`,
    chatgptWeb: { browserInteractionMode: "manual", browserHost: "launcher", localToolsEnabled: true,
      browserHostDescriptorPath: join(root, "launcher.json"), brokerSocketPath: socket, turnTimeoutMs: options.timeoutMs } };
  const namespace = chatGptWebExecutionNamespace(provider);
  traceId = chatGptTurnTraceId(parsed, namespace);
  if (options.retiringSurface) {
    const logical = deferred<string>();
    chatGptTurnSessions.getOrCreate(`${root}:different-execution`, () => ({ mode: "read-only",
      browser: logical.promise, physicalSettlement: options.retiringSurface,
      conversationKey: chatGptConversationKey(parsed, namespace),
      trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
      cancel() { retiring.resolve(); logical.resolve("retired"); },
    }));
  }
  const adapter = createChatGptWebAdapter(provider,
  { broker, zeroRiskManualControl: control, worker: { run: async () => { throw new Error("No Automatic compaction worker"); } } });
  return {
    parsed, started: started.promise, restarted: restarted.promise, ending: ending.promise,
    retiring: retiring.promise, ended, starts: () => starts,
    cancel: () => cancelStructuredCompactionTrace(traceId, new Error("operator cancelled checkpoint")),
    assertRevoked: () => expect(() => broker.startSafeTurn(requestId)).toThrow(/revoked|invalid/),
    complete: (answer: string) => broker.completeSafeTurn(requestId, answer),
    run: (events: AdapterEvent[], signal?: AbortSignal) => adapter.runTurn!(parsed,
      { headers: new Headers(), abortSignal: signal }, event => events.push(event)),
    compact: () => {
      const config = defaultConfig("full");
      config.browserInteractionMode = "manual";
      config.appName = config.manualAppName;
      return compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...parsed._rawBody as object, model: "chatgpt-web/zero-risk" }),
      }), config, () => adapter);
    },
    async close() {
      chatGptTurnSessions.clear();
      await cancelAllStructuredCompactions(new Error("test cleanup"));
      await broker.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const canonicalMarker of [false, true]) test(`manual compaction normalizes trailing whitespace before emission (marker: ${canonicalMarker})`, async () => {
  const testCase = fixture();
  const events: AdapterEvent[] = [];
  const running = testCase.run(events);
  void running.catch(() => {});
  try {
    await testCase.started;
    const canonical = canonicalizeCompactionHandoff(testCase.parsed, "A complete checkpoint summary.")!;
    testCase.complete((canonicalMarker ? canonical : "A complete checkpoint summary.") + " \n");
    await running;
    expect(events.filter(event => event.type === "text_delta").map(event => event.type === "text_delta" ? event.text : "").join(""))
      .toBe(canonical);
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  } finally { await testCase.close(); }
});

for (const cause of ["operator", "deadline"] as const) test(`manual compaction ${cause} before start waits for the retired surface`, async () => {
  const physical = deferred<void>();
  const testCase = fixture({ retiringSurface: physical.promise, timeoutMs: cause === "deadline" ? 100 : undefined });
  let settled = false;
  const running = testCase.run([]).finally(() => { settled = true; });
  void running.catch(() => {});
  let cancellation: Promise<number> | undefined;
  let cancelled = false;
  try {
    await testCase.retiring;
    if (cause === "operator") cancellation = testCase.cancel().then(count => { cancelled = true; return count; });
    await Bun.sleep(cause === "deadline" ? 150 : 20);
    expect(settled).toBe(false);
    expect(cancelled).toBe(false);
    expect(testCase.starts()).toBe(0);
    physical.resolve();
    await expect(running).rejects.toThrow();
    if (cancellation) expect(await cancellation).toBe(1);
    expect(testCase.starts()).toBe(0);
  } finally {
    physical.resolve();
    await testCase.close();
    await cancellation;
    await running.catch(() => {});
  }
});

for (const [error, code] of [
  [new LauncherBrowserTurnCancelledError("User closed the checkpoint"), "manual_turn_cancelled"],
  [new LauncherManualTurnTimedOutError("Checkpoint Sent deadline expired"), "manual_handoff_timeout"],
] as const) test(`compact HTTP preserves typed ${code}`, async () => {
  const testCase = fixture({ waitSentError: error });
  try {
    const response = await testCase.compact();
    // The compact HTTP contract maps terminal invalid_request_error to non-retryable 400.
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error", code } });
    expect(testCase.ended).toEqual(["failed"]);
    testCase.assertRevoked();
    expect(chatGptTurnSessions.activeCount()).toBe(0);
  } finally { await testCase.close(); }
});
test("a disconnected compact observer reconnects to the same manual checkpoint", async () => {
  const testCase = fixture();
  const disconnected = new AbortController();
  const first = testCase.run([], disconnected.signal);
  void first.catch(() => {});
  let second: Promise<void> | undefined;
  try {
    await testCase.started;
    disconnected.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    const events: AdapterEvent[] = [];
    second = testCase.run(events);
    void second.catch(() => {});
    await Bun.sleep(20);
    expect(testCase.starts()).toBe(1);
    expect(testCase.ended).toEqual([]);
    testCase.complete("Checkpoint survives observer reconnect.");
    await second;
    const replay: AdapterEvent[] = [];
    await testCase.run(replay);
    expect(replay.filter(event => event.type === "text_delta"))
      .toEqual(events.filter(event => event.type === "text_delta"));
    expect(testCase.starts()).toBe(1);
    expect(testCase.ended).toEqual(["completed"]);
  } finally {
    await testCase.close();
    await second?.catch(() => {});
  }
});

for (const cause of ["operator", "deadline"] as const) test(`manual compaction ${cause} waits for physical cleanup before failure and retry`, async () => {
  const release = deferred<void>();
  const testCase = fixture({ endGate: release.promise, timeoutMs: cause === "deadline" ? 1_000 : undefined });
  const events: AdapterEvent[] = [];
  let settled = false;
  const first = testCase.run(events).finally(() => { settled = true; });
  void first.catch(() => {});
  let cancellation: Promise<number> | undefined;
  let retry: Promise<void> | undefined;
  try {
    await testCase.started;
    if (cause === "operator") cancellation = testCase.cancel();
    await testCase.ending;
    expect(settled).toBe(false);
    expect(events.some(event => event.type === "done")).toBe(false);
    testCase.assertRevoked();
    release.resolve();
    await expect(first).rejects.toThrow(cause === "operator" ? "operator cancelled checkpoint" : "did not fully settle");
    if (cancellation) expect(await cancellation).toBe(1);
    expect(chatGptTurnSessions.activeCount()).toBe(0);
    retry = testCase.run([]);
    void retry.catch(() => {});
    await testCase.restarted;
    expect(testCase.starts()).toBe(2);
    testCase.complete("The explicit retry completed.");
    await retry;
    expect(testCase.ended).toEqual(["aborted", "completed"]);
  } finally {
    release.resolve();
    await testCase.close();
    await cancellation;
    await retry?.catch(() => {});
  }
});
