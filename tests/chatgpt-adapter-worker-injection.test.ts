import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter, chatGptWebExecutionNamespace, chatGptWebTraceId } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_ACCOUNT_SAFETY_DRAIN_PROMPT, ChatGptAccountSafety } from "../src/adapters/chatgpt-web/account-safety";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  chatGptCompactionSourceExecutionKey,
  chatGptTurnSessions,
} from "../src/adapters/chatgpt-web/turn-execution";
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

test("archive reads advance production browser progress without fabricating a tool batch", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-archive-progress-"));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  const environment = `<environment_context><cwd>${root}</cwd><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></environment_context>`;
  let observed = false;
  const worker = {
    async run(turn: BrowserTurn): Promise<string> {
      const prepared = await turn.prepare();
      try {
        expect(prepared.transport).toBe("native2-archive");
        const contextToken = prepared.text.match(/context_[a-f0-9]{32}/)?.[0];
        expect(contextToken).toBeString();
        const before = turn.externalProgress!.snapshot();
        expect(before.lastBrokerActivityRevision).toBeUndefined();
        await callTurnBroker(socket, { method: "read_context", token: contextToken! });
        const after = turn.externalProgress!.snapshot();
        expect(after.lastBrokerActivityRevision).toBeGreaterThan(before.revision);
        expect(after.lastToolBatchRevision).toBe(0);
        expect(after.activeToolCalls).toBe(0);
        observed = true;
        turn.onTextDelta("archive progress verified");
        return "archive progress verified";
      } finally {
        prepared.release();
      }
    },
  };
  const large = "ARCHIVE_PROGRESS ".repeat(8_000);
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: false,
    context: {
      tools: [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }],
      messages: [
        { role: "user", content: environment, timestamp: 1 },
        { role: "user", content: large, timestamp: 2 },
      ],
    },
    options: { reasoning: "high" },
    _rawBody: {
      prompt_cache_key: root,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: root, turn_id: "archive-progress-turn" }),
      },
      input: [environment, large].map(text => ({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
        internal_chat_message_metadata_passthrough: { turn_id: "archive-progress-turn" },
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
        useEnhancedOutputTunnel: false,
      },
    }, { broker, worker }).runTurn!(parsed, { headers: new Headers() }, () => {});
    expect(observed).toBeTrue();
  } finally {
    chatGptTurnSessions.clear();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Standard Web delivers queued account-safety steering to the active browser turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-standard-safety-steering-"));
  const safety = new ChatGptAccountSafety(join(root, "state.json"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "browser://standard-safety-steering",
    chatgptWeb: { localToolsEnabled: false, useEnhancedWebSessionMode: false },
  };
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: false,
    context: { messages: [{ role: "user", content: "long running work", timestamp: 1 }] },
    options: { reasoning: "high" },
    _rawBody: {
      prompt_cache_key: "standard-safety-steering-thread",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "standard-safety-steering-thread",
          turn_id: "standard-safety-steering-turn",
        }),
      },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "long running work" }],
        internal_chat_message_metadata_passthrough: { turn_id: "standard-safety-steering-turn" },
      }],
    },
  };
  let workerStarted!: () => void;
  const started = new Promise<void>(resolve => { workerStarted = resolve; });
  let continueWorker!: () => void;
  const continueRun = new Promise<void>(resolve => { continueWorker = resolve; });
  let observedRetryPrompt: string | undefined;
  const worker = {
    async run(turn: BrowserTurn): Promise<string> {
      const prepared = await turn.prepare();
      prepared.release();
      workerStarted();
      await continueRun;
      const retry = await turn.retryPromptForAnswer?.("partial answer", 1);
      observedRetryPrompt = typeof retry === "string" ? retry : retry?.text;
      turn.onTextDelta("standard safety answer");
      return "standard safety answer";
    },
    requestPreemptiveRetry: () => false,
  };
  const events: AdapterEvent[] = [];
  const run = createChatGptWebAdapter(provider, { worker, accountSafety: safety }).runTurn!(
    parsed,
    { headers: new Headers() },
    event => events.push(event),
  );

  try {
    await started;
    await Promise.resolve();
    expect(chatGptTurnSessions.steerTrace(
      chatGptWebTraceId(provider, parsed),
      CHATGPT_ACCOUNT_SAFETY_DRAIN_PROMPT,
    )).toBe(true);
    continueWorker();
    await run;
    expect(observedRetryPrompt).toContain(CHATGPT_ACCOUNT_SAFETY_DRAIN_PROMPT);
    expect(events.at(-1)?.type).toBe("done");
  } finally {
    continueWorker();
    await run.catch(() => {});
    chatGptTurnSessions.clear();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Luna checkpoint turns deliver account-safety steering without enabling generic steering", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-luna-safety-steering-"));
  const safety = new ChatGptAccountSafety(join(root, "state.json"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "browser://luna-safety-steering",
    chatgptWeb: { localToolsEnabled: false, useEnhancedWebSessionMode: true, solAvailable: false },
  };
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_LUNA_MODEL_ID,
    stream: false,
    context: { messages: [{ role: "user", content: "long running Luna work", timestamp: 1 }] },
    options: { reasoning: "medium" },
    _rawBody: {
      prompt_cache_key: "luna-safety-steering-thread",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "luna-safety-steering-thread",
          turn_id: "luna-safety-steering-turn",
        }),
      },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "long running Luna work" }],
        internal_chat_message_metadata_passthrough: { turn_id: "luna-safety-steering-turn" },
      }],
    },
  };
  let workerStarted!: () => void;
  const started = new Promise<void>(resolve => { workerStarted = resolve; });
  let continueWorker!: () => void;
  const continueRun = new Promise<void>(resolve => { continueWorker = resolve; });
  let observedSafetyRetry: Awaited<ReturnType<NonNullable<BrowserTurn["retryPromptForAnswer"]>>>;
  const worker = {
    async run(turn: BrowserTurn): Promise<string> {
      const prepared = await turn.prepare();
      prepared.release();
      expect(turn.captureLunaCheckpoint).toBeTrue();
      workerStarted();
      await continueRun;
      observedSafetyRetry = await turn.retryPromptForAnswer?.("luna safety answer", 1);
      turn.onTextDelta("luna safety answer");
      return "luna safety answer";
    },
    requestPreemptiveRetry: () => false,
  };
  const run = createChatGptWebAdapter(provider, { worker, accountSafety: safety }).runTurn!(
    parsed,
    { headers: new Headers() },
    () => {},
  );

  try {
    await started;
    await Promise.resolve();
    expect(chatGptTurnSessions.steerTrace(
      chatGptWebTraceId(provider, parsed),
      CHATGPT_ACCOUNT_SAFETY_DRAIN_PROMPT,
    )).toBe(false);
    const safetySteer = (chatGptTurnSessions as typeof chatGptTurnSessions & {
      steerSafetyTrace?: (traceId: string, instruction: string) => boolean;
    }).steerSafetyTrace;
    expect(safetySteer?.call(
      chatGptTurnSessions,
      chatGptWebTraceId(provider, parsed),
      CHATGPT_ACCOUNT_SAFETY_DRAIN_PROMPT,
    )).toBe(true);
    continueWorker();
    await run;
    expect(observedSafetyRetry).toEqual({
      text: CHATGPT_ACCOUNT_SAFETY_DRAIN_PROMPT,
      allowLunaCheckpointRetry: true,
    });
  } finally {
    continueWorker();
    await run.catch(() => {});
    chatGptTurnSessions.clear();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Luna rejects account-safety steering after final-answer admission seals", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-luna-safety-final-boundary-"));
  const safety = new ChatGptAccountSafety(join(root, "state.json"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "browser://luna-safety-final-boundary",
    chatgptWeb: { localToolsEnabled: false, useEnhancedWebSessionMode: true, solAvailable: false },
  };
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_LUNA_MODEL_ID,
    stream: false,
    context: { messages: [{ role: "user", content: "finish Luna work", timestamp: 1 }] },
    options: { reasoning: "medium" },
    _rawBody: {
      prompt_cache_key: "luna-safety-final-boundary-thread",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "luna-safety-final-boundary-thread",
          turn_id: "luna-safety-final-boundary-turn",
        }),
      },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "finish Luna work" }],
        internal_chat_message_metadata_passthrough: { turn_id: "luna-safety-final-boundary-turn" },
      }],
    },
  };
  let admissionSealed!: () => void;
  const sealed = new Promise<void>(resolve => { admissionSealed = resolve; });
  let finishWorker!: () => void;
  const finish = new Promise<void>(resolve => { finishWorker = resolve; });
  const worker = {
    async run(turn: BrowserTurn): Promise<string> {
      const prepared = await turn.prepare();
      prepared.release();
      expect(turn.captureLunaCheckpoint).toBeTrue();
      expect(turn.finalAnswerAdmission).toBeDefined();
      expect(turn.finalAnswerAdmission!.seal()).toBe(true);
      admissionSealed();
      await finish;
      turn.onTextDelta("final Luna answer");
      return "final Luna answer";
    },
    requestPreemptiveRetry: () => false,
  };
  const run = createChatGptWebAdapter(provider, { worker, accountSafety: safety }).runTurn!(
    parsed,
    { headers: new Headers() },
    () => {},
  );

  try {
    await sealed;
    expect(chatGptTurnSessions.steerTrace(
      chatGptWebTraceId(provider, parsed),
      CHATGPT_ACCOUNT_SAFETY_DRAIN_PROMPT,
    )).toBe(false);
    expect(chatGptTurnSessions.steerSafetyTrace(
      chatGptWebTraceId(provider, parsed),
      CHATGPT_ACCOUNT_SAFETY_DRAIN_PROMPT,
    )).toBe(false);
    finishWorker();
    await run;
  } finally {
    finishWorker();
    await run.catch(() => {});
    chatGptTurnSessions.clear();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Automatic Web rejects new work while account safety is paused", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-safety-paused-"));
  const safety = new ChatGptAccountSafety(join(root, "state.json"));
  safety.trigger("rate_limit", []);
  let workerRuns = 0;
  const worker = {
    async run(): Promise<string> { workerRuns += 1; return "must not run"; },
    requestPreemptiveRetry: () => false,
  };
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: false,
    context: { messages: [{ role: "user", content: "new work", timestamp: 1 }] },
    options: { reasoning: "high" },
    _rawBody: {
      prompt_cache_key: "safety-paused-thread",
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "safety-paused-thread", turn_id: "safety-paused-turn" }) },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "new work" }],
        internal_chat_message_metadata_passthrough: { turn_id: "safety-paused-turn" } }],
    },
  };
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter({
      adapter: "chatgpt-web", baseUrl: "browser://safety-paused", chatgptWeb: { localToolsEnabled: false },
    }, { worker, accountSafety: safety } as never).runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
    expect(workerRuns).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: "error", code: "chatgpt_account_safety_paused", retryable: false,
    }));
  } finally {
    chatGptTurnSessions.clear();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rolling session-limit rejection points to window reset instead of Resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-safety-session-limit-"));
  const safety = new ChatGptAccountSafety(join(root, "state.json"));
  safety.admit("seed-trace", "seed-session", 1, 300, [], Date.now());
  safety.status(1, 300, []);
  let workerRuns = 0;
  const worker = {
    async run(): Promise<string> { workerRuns += 1; return "must not run"; },
    requestPreemptiveRetry: () => false,
  };
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: false,
    context: { messages: [{ role: "user", content: "new session", timestamp: 1 }] },
    options: { reasoning: "high" },
    _rawBody: {
      prompt_cache_key: "safety-session-limit-thread",
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "safety-session-limit-thread", turn_id: "safety-session-limit-turn" }) },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "new session" }],
        internal_chat_message_metadata_passthrough: { turn_id: "safety-session-limit-turn" } }],
    },
  };
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter({
      adapter: "chatgpt-web",
      baseUrl: "browser://safety-session-limit",
      chatgptWeb: {
        localToolsEnabled: false,
        automaticWebSessionLimitCount: 1,
        automaticWebSessionLimitMinutes: 300,
      },
    }, { worker, accountSafety: safety } as never).runTurn!(
      parsed,
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(workerRuns).toBe(0);
    const failure = events.find(event => event.type === "error");
    expect(failure).toMatchObject({ type: "error", code: "chatgpt_account_safety_paused", retryable: false });
    expect(failure && "message" in failure ? failure.message : "").toContain("Reset usage");
    expect(failure && "message" in failure ? failure.message : "").not.toContain("Resume");
  } finally {
    chatGptTurnSessions.clear();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Automatic Web derives rolling session identity from Standard and Enhanced modes", async () => {
  const admissions: Array<{ mode: "standard" | "enhanced"; traceId: string; sessionId: string }> = [];
  let mode: "standard" | "enhanced" = "standard";
  const safety = {
    retainTrace() {},
    releaseTrace() {},
    activeTraceIds(traceIds: readonly string[]) { return [...traceIds]; },
    admit(traceId: string, sessionId: string) {
      admissions.push({ mode, traceId, sessionId });
      return {
        allowed: true,
        status: { state: "NORMAL", usedSessions: 0, capturedTraceIds: [] },
        steeringTraceIds: [],
      };
    },
    markSteeringQueued() {},
    status() { return { state: "NORMAL", usedSessions: 0, capturedTraceIds: [] }; },
    tick() { return []; },
    trigger() { return []; },
  };
  const worker = {
    async run(turn: BrowserTurn): Promise<string> {
      const prepared = await turn.prepare();
      prepared.release();
      turn.onTextDelta("identity answer");
      return "identity answer";
    },
    requestPreemptiveRetry: () => false,
  };
  const parsed = (turnId: string): CodexParsedRequest => ({
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: false,
    context: { messages: [{ role: "user", content: turnId, timestamp: 1 }] },
    options: { reasoning: "high" },
    _rawBody: {
      prompt_cache_key: "rolling-identity-session",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "rolling-identity-thread", turn_id: turnId }),
      },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: turnId }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }],
    },
  });
  const run = async (enhanced: boolean, turnId: string) => {
    mode = enhanced ? "enhanced" : "standard";
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: `browser://rolling-identity-${mode}`,
      chatgptWeb: { localToolsEnabled: false, useEnhancedWebSessionMode: enhanced },
    };
    await createChatGptWebAdapter(provider, { worker, accountSafety: safety } as never).runTurn!(
      parsed(turnId),
      { headers: new Headers() },
      () => {},
    );
    chatGptTurnSessions.clear();
  };

  try {
    await run(false, "standard-turn-a");
    await run(false, "standard-turn-b");
    await run(true, "enhanced-turn-a");
    await run(true, "enhanced-turn-b");

    const unique = (targetMode: "standard" | "enhanced") => [
      ...new Map(admissions.filter(item => item.mode === targetMode)
        .map(item => [`${item.traceId}:${item.sessionId}`, item])).values(),
    ];
    const standard = unique("standard");
    expect(standard).toHaveLength(2);
    expect(standard.every(item => item.sessionId === item.traceId)).toBe(true);
    const enhanced = unique("enhanced");
    expect(enhanced).toHaveLength(2);
    expect(new Set(enhanced.map(item => item.traceId)).size).toBe(2);
    expect(new Set(enhanced.map(item => item.sessionId)).size).toBe(1);
    expect(enhanced.every(item => item.sessionId !== item.traceId)).toBe(true);
  } finally {
    chatGptTurnSessions.clear();
  }
});

test("Automatic Web rechecks account safety immediately before runtime start", async () => {
  let admissions = 0;
  let workerRuns = 0;
  const retained = new Set<string>();
  const safety = {
    retainTrace(traceId: string) { retained.add(traceId); },
    releaseTrace(traceId: string) { retained.delete(traceId); },
    activeTraceIds(traceIds: readonly string[]) { return [...new Set([...traceIds, ...retained])]; },
    admit() {
      admissions += 1;
      return admissions === 1
        ? { allowed: true, status: { state: "NORMAL", capturedTraceIds: [] }, steeringTraceIds: [] }
        : {
            allowed: false,
            status: { state: "HARD_STOP", reason: "account_security", capturedTraceIds: [] },
            steeringTraceIds: [],
          };
    },
    markSteeringQueued() {},
    status() {
      return admissions > 1
        ? { state: "HARD_STOP", reason: "account_security", capturedTraceIds: [] }
        : { state: "NORMAL", capturedTraceIds: [] };
    },
    trigger() { return []; },
  };
  const worker = {
    async run(): Promise<string> { workerRuns += 1; return "must not run"; },
    requestPreemptiveRetry: () => false,
  };
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: false,
    context: { messages: [{ role: "user", content: "race", timestamp: 1 }] },
    options: { reasoning: "high" },
    _rawBody: {
      prompt_cache_key: "safety-race-thread",
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "safety-race-thread", turn_id: "safety-race-turn" }) },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "race" }],
        internal_chat_message_metadata_passthrough: { turn_id: "safety-race-turn" } }],
    },
  };
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter({
      adapter: "chatgpt-web", baseUrl: "browser://safety-race", chatgptWeb: { localToolsEnabled: false },
    }, { worker, accountSafety: safety } as never).runTurn!(
      parsed,
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(admissions).toBeGreaterThanOrEqual(2);
    expect(workerRuns).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: "error", code: "chatgpt_account_safety_stop", retryable: false,
    }));
  } finally {
    chatGptTurnSessions.clear();
  }
});

test("duration drain maps enhanced compaction back to the captured source trace", async () => {
  const admissions: { traceId: string; activeTraceIds: string[] }[] = [];
  const retained = new Set<string>();
  const safety = {
    retainTrace(traceId: string) { retained.add(traceId); },
    releaseTrace(traceId: string) { retained.delete(traceId); },
    activeTraceIds(traceIds: readonly string[]) { return [...new Set([...traceIds, ...retained])]; },
    admit(
      traceId: string,
      _sessionId: string,
      _limitCount: number | undefined,
      _limitMinutes: number | undefined,
      activeTraceIds: readonly string[],
    ) {
      admissions.push({ traceId, activeTraceIds: [...activeTraceIds] });
      const allowed = admissions.length === 1 && traceId === "captured-source";
      return {
        allowed,
        status: { state: "DRAINING", reason: "duration_limit", capturedTraceIds: ["captured-source"] },
        steeringTraceIds: [],
      };
    },
    markSteeringQueued() {},
    status() { return { state: "DRAINING", reason: "duration_limit", capturedTraceIds: ["captured-source"] }; },
    trigger() { return []; },
  };
  let workerRuns = 0;
  const worker = {
    async run(): Promise<string> { workerRuns += 1; return "must not run"; },
    requestPreemptiveRetry: () => false,
  };
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "browser://safety-compact-drain",
    chatgptWeb: { localToolsEnabled: true, useEnhancedWebSessionMode: true },
  };
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: false,
    context: { messages: [{ role: "user", content: "compact during drain", timestamp: 1 }] },
    options: { reasoning: "high" },
    _compactionRequest: true,
    _rawBody: {
      prompt_cache_key: "safety-compact-drain-thread",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "safety-compact-drain-thread",
          turn_id: "compact-turn",
        }),
      },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "compact during drain" }],
        internal_chat_message_metadata_passthrough: { turn_id: "source-turn" },
      }],
    },
  };
  const namespace = chatGptWebExecutionNamespace(provider);
  const sourceExecutionKey = `${namespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
  chatGptTurnSessions.getOrCreate(sourceExecutionKey, () => ({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel() {},
  }), undefined, undefined, undefined, "captured-source");
  await Promise.resolve();

  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(provider, { worker, accountSafety: safety } as never).runTurn!(
      parsed,
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(admissions.map(admission => admission.traceId)).toEqual(["captured-source", "captured-source"]);
    expect(admissions[1]!.activeTraceIds).toContain("captured-source");
    expect(workerRuns).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: "error", code: "chatgpt_account_safety_paused", retryable: false,
    }));
  } finally {
    chatGptTurnSessions.clear();
  }
});

test("a ChatGPT rate-limit failure pauses Automatic Web even without a proactive window", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-safety-rate-"));
  const safety = new ChatGptAccountSafety(join(root, "state.json"));
  const worker = {
    async run(): Promise<string> {
      throw new ChatGptWebAdapterError("Too many requests", {
        status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: false, retireSession: true,
      });
    },
    requestPreemptiveRetry: () => false,
  };
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: false,
    context: { messages: [{ role: "user", content: "rate limited", timestamp: 1 }] },
    options: { reasoning: "high" },
    _rawBody: {
      prompt_cache_key: "safety-rate-thread",
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "safety-rate-thread", turn_id: "safety-rate-turn" }) },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "rate limited" }],
        internal_chat_message_metadata_passthrough: { turn_id: "safety-rate-turn" } }],
    },
  };
  try {
    await createChatGptWebAdapter({
      adapter: "chatgpt-web", baseUrl: "browser://safety-rate", chatgptWeb: { localToolsEnabled: false },
    }, { worker, accountSafety: safety } as never).runTurn!(parsed, { headers: new Headers() }, () => {});
    expect(safety.status(undefined, undefined, []).state).toBe("PAUSED");
    expect(safety.status(undefined, undefined, []).reason).toBe("rate_limit");
  } finally {
    chatGptTurnSessions.clear();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Enhanced compaction rate limits update account safety", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-safety-compact-rate-"));
  const safety = new ChatGptAccountSafety(join(root, "state.json"));
  const worker = {
    async run(): Promise<string> {
      throw new ChatGptWebAdapterError("Too many requests", {
        status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: false, retireSession: true,
      });
    },
    requestPreemptiveRetry: () => false,
  };
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: false,
    context: { messages: [{ role: "user", content: "compact", timestamp: 1 }] },
    options: { reasoning: "high" },
    _compactionRequest: true,
    _rawBody: {
      prompt_cache_key: "safety-compact-rate-thread",
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "safety-compact-rate-thread", turn_id: "safety-compact-rate-turn" }) },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "compact" }],
        internal_chat_message_metadata_passthrough: { turn_id: "safety-compact-rate-turn" } }],
    },
  };
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter({
      adapter: "chatgpt-web", baseUrl: "browser://safety-compact-rate",
      chatgptWeb: { localToolsEnabled: true, useEnhancedWebSessionMode: true },
    }, { worker, accountSafety: safety } as never).runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
    expect(safety.status(undefined, undefined, [])).toMatchObject({ state: "PAUSED", reason: "rate_limit" });
    expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "rate_limit_exceeded", status: 429 }));
  } finally {
    chatGptTurnSessions.clear();
    rmSync(root, { recursive: true, force: true });
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
