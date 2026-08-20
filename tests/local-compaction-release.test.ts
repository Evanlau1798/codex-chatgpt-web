import { describe, expect, test } from "bun:test";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSessions,
} from "../src/adapters/chatgpt-web/turn-execution";
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

describe("Codex local compaction lifecycle", () => {
  test("classifies local compaction from Codex turn metadata rather than prompt text", () => {
    const compact = parseRequest(localCompactBody());
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
    const parsed = parseRequest(localCompactBody());

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
