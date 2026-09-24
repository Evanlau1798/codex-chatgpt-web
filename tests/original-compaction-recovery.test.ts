import { ChatGptAccountSafety } from "../src/adapters/chatgpt-web/account-safety";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError, chatGptRetainedSurfaceUnavailableError } from "../src/adapters/chatgpt-web/adapter-error";
import { cancelStructuredCompactionTrace } from "../src/adapters/chatgpt-web/compaction-handoff";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import { chatGptWebExecutionNamespace, createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptCompactionSourceExecutionKey, chatGptTurnExecutionKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

function shortSocketTempRoot(): string {
  return process.platform === "win32" ? tmpdir() : "/tmp";
}

function request(compaction = false): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    context: {
      messages: [
        { role: "user", content: "Original task", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Work completed" }], timestamp: 2 },
        { role: "user", content: "Continue with the next step", timestamp: 3 },
      ],
    },
    options: { reasoning: "high" },
    _compactionRequest: compaction,
    _rawBody: {
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue with the next step" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_source" },
      }],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_retained_compaction",
          turn_id: compaction ? "turn_compact" : "turn_source",
        }),
      },
    },
  };
}

test.each([false, true])("Original compact sends complete opaque context when its retained source is absent (Bigger Context=%s)", async experimentalBiggerContext => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-missing-retained-compact-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://missing-retained-${Date.now()}`,
    chatgptWeb: {
      experimentalBiggerContext,
      useEnhancedWebSessionMode: false,
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true, proAvailable: true,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let browserStarts = 0;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserStarts += 1;
    expect(turn.requireRetainedConversation).toBeUndefined();
    expect(turn.conversationKey).toBeUndefined();
    expect(turn.compaction).toBeTrue();
    const prepared = await turn.prepare();
    const contextText = prepared.multipart?.parts.join("\n") ?? prepared.text;
    expect(contextText).toContain("Original task");
    expect(contextText).toContain("Continue with the next step");
    if (experimentalBiggerContext) {
      expect(prepared.multipart!.parts).toHaveLength(6);
      expect(prepared.trimmedCompactionMessages).toBeUndefined();
      const lastRecord = prepared.multipart!.parts.flatMap(part => JSON.parse(part).records).at(-1);
      expect(lastRecord.message.content).toBe(compact.context.messages.at(-1)!.content);
    }
    prepared.release();
    turn.onTextDelta("Fallback checkpoint from canonical Codex context");
    return "Fallback checkpoint from canonical Codex context";
  };
  const compact = request(true);
  const events: AdapterEvent[] = [];
  if (experimentalBiggerContext) compact.context.messages.at(-1)!.content += "x".repeat(160_000);
  try {
    await createChatGptWebAdapter(provider, { accountSafety: new ChatGptAccountSafety(join(root, "account-safety.json")) }).runTurn!(
      compact,
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(browserStarts).toBe(1);
    expect(events.some(event => event.type === "text_delta"
      && event.text.includes("Fallback checkpoint from canonical Codex context"))).toBeTrue();
    expect(events.some(event => event.type === "text_delta"
      && event.text.includes("CODEX_LATEST_USER_PROMPT_JSON"))).toBeFalse();
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([false, true])("configured fresh compaction waits for cleanup and preserves committed final=%s", async committed => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-fresh-owner-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web", baseUrl: `browser://fresh-owner-${root}`,
    chatgptWeb: { useEnhancedWebSessionMode: false, browserHost: "launcher", browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root), localToolsEnabled: true, solAvailable: true,
      experimentalFreshConversationPerTurn: true },
  };
  const compact = request(true);
  const sourceKey = `${chatGptWebExecutionNamespace(provider)}:${chatGptCompactionSourceExecutionKey(compact)}`;
  let finishSource!: (answer: string) => void;
  let releaseSource!: () => void;
  let cancelled = false;
  const cleanup = new Promise<void>(resolve => { releaseSource = resolve; });
  const source = chatGptTurnSessions.getOrCreate(sourceKey, () => ({
    mode: "read-only", browser: new Promise<string>(resolve => { finishSource = resolve; }),
    physicalSettlement: cleanup, trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    cancel: () => { cancelled = true; finishSource("retired source"); },
  }));
  if (committed) {
    finishSource("committed final");
    await source.browserOutcome;
  }
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run;
  let starts = 0;
  worker.run = async turn => { starts += 1; turn.onTextDelta("Fresh checkpoint"); return "Fresh checkpoint"; };
  const events: AdapterEvent[] = [];
  let pending: Promise<void> | undefined;
  try {
    pending = createChatGptWebAdapter(provider, { accountSafety: new ChatGptAccountSafety(join(root, "account-safety.json")) }).runTurn!(compact, { headers: new Headers() }, event => events.push(event));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(cancelled).toBe(!committed);
    expect(starts).toBe(0);
    releaseSource();
    await pending;
    expect(starts).toBe(1);
    expect(chatGptTurnSessions.find(sourceKey)).toBe(committed ? source : undefined);
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  } finally {
    finishSource("cleanup");
    releaseSource();
    await pending;
    worker.run = originalRun;
    chatGptTurnSessions.clear();
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([false, true])("structured compact rebuild after retained browser loss preserves rate limit=%s", async rateLimited => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-stale-retained-compact-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://stale-retained-${Date.now()}`,
    chatgptWeb: {
      useEnhancedWebSessionMode: true,
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true, proAvailable: true,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const sourceRequest = request(false);
  const namespace = chatGptWebExecutionNamespace(provider);
  const sourceKey = `${namespace}:${chatGptTurnExecutionKey(sourceRequest)}`;
  chatGptTurnSessions.getOrCreate(sourceKey, () => ({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest,
    conversationKey: chatGptConversationKey(sourceRequest, namespace)!,
    cancel() {},
  }));
  await chatGptTurnSessions.find(sourceKey)!.browserOutcome;

  let browserStarts = 0;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserStarts += 1;
    if (turn.requireRetainedConversation) throw chatGptRetainedSurfaceUnavailableError(new Error("retained fixture lost"));
    const prepared = await turn.prepare();
    expect(prepared.text).toContain("Original task");
    prepared.release();
    if (rateLimited) throw new ChatGptWebAdapterError("ChatGPT rate limit: too many requests.", {
      status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: false,
    });
    return "Fallback checkpoint after retained browser loss";
  };
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(provider, { accountSafety: new ChatGptAccountSafety(join(root, "account-safety.json")) }).runTurn!(
      request(true),
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(browserStarts).toBe(2);
    if (rateLimited) {
      expect(events.at(-1)).toMatchObject({
        type: "error", status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded",
        retryable: false, message: "ChatGPT rate limit: too many requests.",
      });
      expect(events.some(event => event.type === "done")).toBeFalse();
      return;
    }
    expect(events.some(event => event.type === "text_delta"
      && event.text.includes("Fallback checkpoint after retained browser loss"))).toBeTrue();
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a disappeared retained source cannot leave its fresh compaction rebuild past the shared deadline", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-stale-retained-deadline-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://stale-retained-deadline-${Date.now()}`,
    chatgptWeb: {
      useEnhancedWebSessionMode: true,
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true, proAvailable: true,
      turnTimeoutMs: 25,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const sourceRequest = request(false);
  const namespace = chatGptWebExecutionNamespace(provider);
  const sourceKey = `${namespace}:${chatGptTurnExecutionKey(sourceRequest)}`;
  chatGptTurnSessions.getOrCreate(sourceKey, () => ({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest,
    conversationKey: chatGptConversationKey(sourceRequest, namespace)!,
    cancel() {},
  }));
  await chatGptTurnSessions.find(sourceKey)!.browserOutcome;

  let browserStarts = 0;
  let releaseBrowser: (() => void) | undefined;
  let fallbackTrace = "";
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserStarts += 1;
    if (turn.requireRetainedConversation) throw chatGptRetainedSurfaceUnavailableError(new Error("retained fixture lost"));
    fallbackTrace = turn.traceId;
    return new Promise<string>(resolve => { releaseBrowser = () => resolve("browser cleanup completed"); });
  };
  const events: AdapterEvent[] = [];
  const startedAt = performance.now();
  try {
    await expect(createChatGptWebAdapter(provider, { accountSafety: new ChatGptAccountSafety(join(root, "account-safety.json")) }).runTurn!(
      request(true),
      { headers: new Headers() },
      event => events.push(event),
    )).rejects.toMatchObject({ code: "compaction_handoff_timeout", retryable: false, message: "ChatGPT compaction did not fully settle within 25ms" });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(browserStarts).toBe(2);
    expect(events.some(event => event.type === "done")).toBeFalse();
  } finally {
    releaseBrowser?.();
    await cancelStructuredCompactionTrace(fallbackTrace, new Error("test cleanup"));
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});
