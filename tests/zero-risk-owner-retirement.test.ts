import { expect, test } from "bun:test";
import { sessionForChatGptRequest } from "../src/adapters/chatgpt-web/steering";
import { deferred } from "../src/adapters/chatgpt-web/runtime-lifecycle";
import {
  ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions, chatGptConversationKey,
  chatGptTurnExecutionKey, type ChatGptTurnRuntime,
} from "../src/adapters/chatgpt-web/turn-execution";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import type { CodexParsedRequest } from "../src/types";
import { priorAbortedTurnIds } from "../src/adapters/chatgpt-web/turn-user-revision";

test("only a metadata-owned prior user abort notice grants retirement authority", () => {
  const notice = (role: string, turnId?: string) => ({
    type: "message", role, content: [{ type: "input_text", text: "<turn_aborted>Interrupted</turn_aborted>" }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });
  expect(priorAbortedTurnIds({ input: [
    notice("user", "old"), notice("user", "old"), notice("user", "current"),
    notice("user"), notice("assistant", "assistant-old"),
  ] }, "current")).toEqual(["old"]);
});

function request(thread: string, turn: string, aborted?: string, effort = "low"): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, stream: true, options: { reasoning: effort },
    context: { tools: [], messages: [{ role: "user", content: `Work on ${turn}`, timestamp: 1 }] },
    _rawBody: {
      prompt_cache_key: thread,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: turn }) },
      input: [
        ...(aborted ? [{ type: "message", role: "user", content: [{ type: "input_text", text: "<turn_aborted>Interrupted</turn_aborted>" }],
          internal_chat_message_metadata_passthrough: { turn_id: aborted } }] : []),
        { type: "message", role: "user", content: [{ type: "input_text", text: `Work on ${turn}` }],
          internal_chat_message_metadata_passthrough: { turn_id: turn } },
      ],
    },
  };
}

function runtime(input: CodexParsedRequest) {
  const logical = deferred<string>();
  const physical = deferred<void>();
  let cancelled = false;
  const value: ChatGptTurnRuntime = {
    mode: "tools", token: Promise.resolve("test-token"), browser: logical.promise,
    physicalSettlement: physical.promise, trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    conversationKey: chatGptConversationKey(input, "owner-test"),
    manualControl: { surfaceNonce: "fixture-nonce" },
    cancel() { cancelled = true; logical.resolve("cancelled"); },
  };
  return { value, logical, physical, cancelled: () => cancelled };
}

for (const [aborted, effort] of [[false, "low"], [false, "high"], [true, "high"]] as const) test(`manual next turn respects native ownership (aborted: ${aborted}, effort: ${effort})`, async () => {
  const sessions = new ChatGptTurnSessions();
  const oldInput = request("owner", "old");
  const siblingInput = request("sibling", "old");
  const nextInput = request("owner", "next", aborted ? "old" : undefined, effort);
  const old = runtime(oldInput), sibling = runtime(siblingInput), next = runtime(nextInput);
  const key = (input: CodexParsedRequest) => `owner-test:${chatGptTurnExecutionKey(input)}`;
  const start = (input: CodexParsedRequest, value: ChatGptTurnRuntime) => sessionForChatGptRequest(
    sessions, key(input), input, () => value, "owner-test",
  );
  let nextStarted = false;
  let pending: Promise<unknown> | undefined;
  try {
    await start(oldInput, old.value);
    await start(siblingInput, sibling.value);
    pending = start(nextInput, next.value).then(value => { nextStarted = true; return value; });
    await Bun.sleep(20);
    expect(old.cancelled()).toBe(aborted);
    expect(sibling.cancelled()).toBe(false);
    expect(nextStarted).toBe(false);
    if (!aborted) {
      const detached = new AbortController();
      const waiting = sessionForChatGptRequest(sessions, key(nextInput), nextInput,
        () => next.value, "owner-test", true, undefined, detached.signal);
      detached.abort();
      await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
      expect(old.cancelled()).toBe(false);
    }
    old.logical.resolve("finished");
    await Bun.sleep(20);
    expect(nextStarted).toBe(false);
    old.physical.resolve();
    await pending;
    expect(nextStarted).toBe(true);
    expect(sibling.cancelled()).toBe(false);
  } finally {
    for (const owned of [old, sibling, next]) { owned.logical.resolve("closed"); owned.physical.resolve(); }
    await pending;
    sessions.clear();
  }
});

test("same-turn manual revision reuses its owner with Enhanced disabled", async () => {
  const sessions = new ChatGptTurnSessions();
  const original = request("owner", "same");
  const revised = request("owner", "same");
  revised.context.messages.push({ role: "user", content: "Additional guidance", timestamp: 2 });
  (revised._rawBody as { input: unknown[] }).input.push({
    type: "message", role: "user", content: [{ type: "input_text", text: "Additional guidance" }],
    internal_chat_message_metadata_passthrough: { turn_id: "same" },
  });
  const old = runtime(original), replacement = runtime(revised);
  const key = `owner-test:${chatGptTurnExecutionKey(original)}`;
  let pending: Promise<unknown> | undefined;
  try {
    const first = await sessionForChatGptRequest(sessions, key, original, () => old.value, "owner-test", false);
    pending = sessionForChatGptRequest(sessions, key, revised, () => replacement.value, "owner-test", false);
    await Bun.sleep(20);
    expect(old.cancelled()).toBe(false);
    expect(await pending).toBe(first);
  } finally {
    for (const owned of [old, replacement]) { owned.logical.resolve("closed"); owned.physical.resolve(); }
    await pending;
    sessions.clear();
  }
});
