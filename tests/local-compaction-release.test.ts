import { describe, expect, test } from "bun:test";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSessions,
  chatGptConversationKey, chatGptTurnExecutionKey, chatGptTurnRoundKey, chatGptTurnTraceId,
  chatGptCompactionSourceExecutionKey,
} from "../src/adapters/chatgpt-web/turn-execution";
import { chatGptTurnRetryKey, chatGptModelFailureKey } from "../src/adapters/chatgpt-web/turn-retry-identity";
import { sessionForChatGptRequest } from "../src/adapters/chatgpt-web/steering";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexProviderConfig } from "../src/types";

function localCompactBody(requestKind = "compaction") {
  return {
    model: CHATGPT_WEB_MODEL_ID,
    stream: true,
    reasoning: { effort: "high", summary: "auto" },
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: "thread-local-compact",
        turn_id: "turn-local-compact",
        request_kind: requestKind,
        ...(requestKind === "compaction" ? {
          compaction: {
            trigger: "manual",
            reason: "user_requested",
            implementation: "responses",
            phase: "standalone_turn",
            strategy: "memento",
          },
        } : {}),
      }),
    },
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Create the context checkpoint." }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn-local-compact" },
    }],
  };
}

function runtime(conversationKey: string, release: () => Promise<void>, cancel: () => void) {
  return {
    mode: "read-only" as const,
    browser: Promise.resolve("complete"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey,
    cancel,
    release,
  };
}

function sameTurnCompactions() {
  const base = localCompactBody("turn");
  const input = [{ ...base.input[0], id: "current-user" },
    { type: "function_call", call_id: "read-current", name: "read", arguments: '{"path":"notes"}' },
    { type: "function_call_output", call_id: "read-current", output: "read exactly once" }];
  const body = { ...base, input, tools: [{ type: "function", name: "read", parameters: { type: "object", properties: {} } }] };
  const metadata = JSON.parse(base.client_metadata["x-codex-turn-metadata"]);
  const ordinary = parseRequest(body);
  const local = parseRequest({ ...body, client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({ ...metadata, request_kind: "compaction" }),
  } });
  const remote = parseRequest({ ...body, input: [...input, { type: "compaction_trigger" }] });
  ordinary._canonicalContextComplete = local._canonicalContextComplete = true;
  return { ordinary, local, remote };
}

test("same-turn ordinary, legacy-local and native compaction have isolated identities", () => {
  const { ordinary, local, remote } = sameTurnCompactions();
  expect(local._localCompactionRequest).toBeTrue();
  expect(local._compactionRequest).toBeUndefined();
  expect(remote._compactionRequest).toBeTrue();
  expect(chatGptCompactionSourceExecutionKey(local)).toBe(chatGptTurnExecutionKey(ordinary));
  for (const key of [chatGptTurnExecutionKey, chatGptTurnRoundKey, chatGptTurnRetryKey, chatGptModelFailureKey])
    expect(new Set([ordinary, local, remote].map(parsed => key(parsed))).size).toBe(3);
  expect(new Set([ordinary, local, remote].map(parsed => chatGptTurnTraceId(parsed, "local-isolation"))).size).toBe(3);
});

test("legacy local model rejection survives harness refresh but distinguishes changed native work", () => {
  const { local } = sameTurnCompactions();
  const body = local._rawBody as { input: unknown[]; [key: string]: unknown };
  const refreshed = parseRequest({ ...body, input: [{ type: "message", role: "developer", content: "Refreshed harness" }, ...body.input] });
  expect(chatGptTurnExecutionKey(refreshed)).not.toBe(chatGptTurnExecutionKey(local));
  expect(chatGptModelFailureKey(refreshed)).toBe(chatGptModelFailureKey(local));
  const changed = parseRequest({ ...body, input: [...body.input, { type: "message", role: "user", id: "new-request",
    content: "New authorized work", internal_chat_message_metadata_passthrough: { turn_id: "turn-local-compact" } }] });
  expect(chatGptModelFailureKey(changed)).not.toBe(chatGptModelFailureKey(local));
});

test("mid-turn legacy compaction retires the active tool owner before starting an isolated read-only runtime", async () => {
  const { ordinary, local } = sameTurnCompactions();
  const sessions = new ChatGptTurnSessions();
  const namespace = "local-isolation";
  const conversation = chatGptConversationKey(ordinary, namespace)!;
  const key = (parsed: typeof ordinary) => `${namespace}:${chatGptTurnExecutionKey(parsed)}`;
  let finish!: (text: string) => void;
  let cancelled = 0, released = 0, compactStarts = 0;
  const browser = new Promise<string>(resolve => { finish = resolve; });
  try {
    const source = await sessionForChatGptRequest(sessions, key(ordinary), ordinary, () => ({
      mode: "tools", token: Promise.resolve("turn_local_compaction_source"), browser,
      conversationKey: conversation, trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
      submission: { phase: "accepted" },
      cancel() { cancelled++; finish("source stopped"); }, release: async () => { released++; },
    }), namespace);
    source.setOutstanding([{ callId: "read-current", wireName: "read", arguments: { path: "notes" }, freeform: false }]);
    source.observeCanonicalRequest(ordinary);
    const result = ordinary.context.messages.find(message => message.role === "toolResult")!;
    source.markResultDelivered("read-current", result);
    expect(source.isActive()).toBeTrue();
    expect(source.hasCanonicalToolResultEvidence(local)).toBeTrue();
    sessions.getOrCreate("unrelated", () => runtime("other-conversation", async () => {}, () => {}));
    const compact = await sessionForChatGptRequest(sessions, key(local), local, () => {
      compactStarts++;
      return runtime(conversation, async () => {}, () => {});
    }, namespace);
    expect(compactStarts).toBe(1);
    expect(compact).not.toBe(source);
    expect(compact.runtime.mode).toBe("read-only");
    expect(compact.runtime).not.toHaveProperty("token");
    expect(cancelled).toBe(1);
    expect(released).toBe(1);
    expect(sessions.find(key(ordinary))).toBeUndefined();
    expect(sessions.find("unrelated")).toBeDefined();
  } finally { finish?.("test cleanup"); sessions.clear(); }
});

describe("Codex local compaction lifecycle", () => {
  test("classifies local compaction from Codex turn metadata rather than prompt text", () => {
    const legacy = localCompactBody();
    const metadata = JSON.parse(legacy.client_metadata["x-codex-turn-metadata"]);
    delete metadata.compaction;
    legacy.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
    const compact = parseRequest(legacy);
    const memento = parseRequest(localCompactBody());
    expect(memento._compactionRequest).toBeTrue();
    expect(memento._compactionResponseFormat).toBe("message");
    const ordinary = parseRequest(localCompactBody("turn"));
    const remote = parseRequest({
      ...localCompactBody(),
      input: [{ type: "compaction_trigger" }],
    });

    expect(compact._localCompactionRequest).toBeTrue();
    expect(compact._compactionRequest).toBeUndefined();
    expect(ordinary._localCompactionRequest).toBeUndefined();
    expect(remote._compactionRequest).toBeTrue();
    expect(remote._localCompactionRequest).toBeUndefined();
  });

  test("retires every owner of one retained conversation and releases its surface once", async () => {
    const sessions = new ChatGptTurnSessions();
    let releases = 0;
    let cancellations = 0;
    const release = async () => { releases += 1; };
    const cancel = () => { cancellations += 1; };
    sessions.getOrCreate("root", () => runtime("conversation-a", release, cancel));
    sessions.getOrCreate("compact", () => runtime("conversation-a", release, cancel));
    sessions.getOrCreate("unrelated", () => runtime("conversation-b", release, cancel));

    expect(await sessions.retireConversationAndWait("conversation-a")).toBe(2);
    expect(cancellations).toBe(2);
    expect(releases).toBe(1);
    expect(sessions.find("root")).toBeUndefined();
    expect(sessions.find("compact")).toBeUndefined();
    expect(sessions.find("unrelated")).toBeDefined();
    sessions.clear();
  });

  test("a successful local compact turn cannot remain cached as a retained owner", async () => {
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: `browser://local-compact-release-${Date.now()}`,
      chatgptWeb: {
        localToolsEnabled: false,
        solAvailable: true,
        proAvailable: true,
        useEnhancedWebSessionMode: true,
      },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    const turns: BrowserTurn[] = [];
    worker.run = turn => {
      turns.push(turn);
      turn.onTextDelta("Checkpoint complete.");
      return Promise.resolve("Checkpoint complete.");
    };
    const legacy = localCompactBody();
    const metadata = JSON.parse(legacy.client_metadata["x-codex-turn-metadata"]);
    delete metadata.compaction;
    legacy.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
    const parsed = parseRequest(legacy);

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const events: AdapterEvent[] = [];
        await createChatGptWebAdapter(provider).runTurn!(
          parsed,
          { headers: new Headers() },
          event => events.push(event),
        );
        expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
      }
      expect(turns).toHaveLength(2);
      expect(turns.every(turn => turn.compaction === true)).toBeTrue();
      expect(turns.every(turn => turn.retainConversation === true)).toBeTrue();
      expect(turns[0]!.conversationKey).toBe(turns[1]!.conversationKey);
    } finally {
      worker.run = originalRun;
    }
  });
});

test("a new conversation owner waits until the prior retained surface is fully released", async () => {
  const sessions = new ChatGptTurnSessions();
  let finishRelease!: () => void;
  const releasePending = new Promise<void>(resolve => { finishRelease = resolve; });
  let replacementStarted = false;
  sessions.getOrCreate("old", () => runtime("conversation-a", () => releasePending, () => {}));

  const retirement = sessions.retireConversationAndWait("conversation-a");
  const replacement = sessions.getOrCreateAfterConversationRetirement(
    "replacement",
    "conversation-a",
    () => {
      replacementStarted = true;
      return runtime("conversation-a", async () => {}, () => {});
    },
  );
  await Bun.sleep(10);
  expect(replacementStarted).toBeFalse();

  finishRelease();
  expect(await retirement).toBe(1);
  expect((await replacement).runtime.conversationKey).toBe("conversation-a");
  expect(replacementStarted).toBeTrue();
  sessions.clear();
});
