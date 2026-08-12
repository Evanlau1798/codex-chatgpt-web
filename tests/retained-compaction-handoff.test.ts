import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { COMPACTION_HANDOFF_MARKER } from "../src/adapters/chatgpt-web/compaction-handoff";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { requestRetainedCompactionHandoff } from "../src/adapters/chatgpt-web/retained-compaction-handoff";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession, chatGptConversationKey } from "../src/adapters/chatgpt-web/turn-execution";
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

test("manual compact uses the source conversation key and sends only a short retained handoff", async () => {
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

  const handoff = await requestRetainedCompactionHandoff(
    worker as never, request(true), source, namespace,
    { localToolsEnabled: false, solAvailable: true, proAvailable: true }, "trace12345678",
  );

  expect(handoff).toBe("The retained Web Agent preserved the completed turn.");
  expect(turn?.conversationKey).toBe(chatGptConversationKey(sourceRequest, namespace));
  expect(turn?.requireRetainedConversation).toBeTrue();
  expect(turn?.retainConversation).toBeUndefined();
  const prepared = await turn!.prepare();
  expect(prepared.text).toContain("Automatic Codex context compaction has started");
  expect(prepared.text).not.toContain("Inspect the project");
  prepared.release();
});

test("manual compact retries a malformed handoff on the retained conversation", async () => {
  const namespace = createHash("sha256").update("retained-compact-retry").digest("hex");
  const source = new ChatGptTurnSession({
    mode: "read-only", browser: Promise.resolve("done"), trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(), usageInput: request(false), cancel: () => {},
  });
  let turn: BrowserTurn | undefined;
  const worker = { run: async (value: BrowserTurn) => {
    turn = value;
    const retry = await value.retryPromptForAnswer?.("malformed checkpoint", 1);
    expect(retry).toContain("required format");
    return `${COMPACTION_HANDOFF_MARKER}\nRecovered retained handoff.`;
  } };

  const handoff = await requestRetainedCompactionHandoff(
    worker as never, request(true), source, namespace,
    { localToolsEnabled: false, solAvailable: true, proAvailable: true }, "trace_retry_123",
  );

  expect(handoff).toBe("Recovered retained handoff.");
  expect(turn?.retryPromptForAnswer).toBeFunction();
});

test("manual compact preserves the connector identity of a tool-mode source", async () => {
  const namespace = createHash("sha256").update("retained-compact-tools").digest("hex");
  const source = new ChatGptTurnSession({
    mode: "tools", token: Promise.resolve("turn_source_token"), browser: Promise.resolve("done"),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), usageInput: request(false), cancel: () => {},
  });
  let turn: BrowserTurn | undefined;
  const worker = { run: async (value: BrowserTurn) => {
    turn = value;
    return `${COMPACTION_HANDOFF_MARKER}\nTool-mode retained handoff.`;
  } };

  await requestRetainedCompactionHandoff(
    worker as never, request(true), source, namespace,
    { localToolsEnabled: false, solAvailable: true, proAvailable: true }, "trace_tools_123",
  );

  expect(turn?.capabilities.localToolsEnabled).toBe(true);
});
