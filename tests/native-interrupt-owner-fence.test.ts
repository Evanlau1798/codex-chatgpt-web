import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { sessionForChatGptRequest } from "../src/adapters/chatgpt-web/steering";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions, type ChatGptTurnRuntime } from "../src/adapters/chatgpt-web/turn-execution";

function request(threadId: string, turnId: string) {
  return parseRequest({
    model: "chatgpt-web/medium",
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }) },
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Continue the task." }], internal_chat_message_metadata_passthrough: { turn_id: turnId } }],
  });
}

test("non-retained Automatic replacement waits for the interrupted owner's physical cleanup only", async () => {
  const sessions = new ChatGptTurnSessions();
  const physical = Promise.withResolvers<void>();
  const browser = Promise.withResolvers<string>();
  const started: string[] = [];
  const completed = (id: string): ChatGptTurnRuntime => {
    started.push(id);
    return { mode: "read-only", browser: Promise.resolve("done"), trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {} };
  };
  try {
    await sessionForChatGptRequest(sessions, "old", request("thread_owner", "turn_old"), () => ({
      mode: "read-only", browser: browser.promise, physicalSettlement: physical.promise,
      trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel: reason => browser.reject(reason),
    }));
    const retired = sessions.cancelNativeTurn("thread_owner", "turn_old", new Error("Codex turn interrupted"));
    expect(retired.cancelled).toBe(1);
    const next = sessionForChatGptRequest(sessions, "next", request("thread_owner", "turn_next"), () => completed("next"));
    await sessionForChatGptRequest(sessions, "other", request("thread_other", "turn_other"), () => completed("other"));
    expect(started).toEqual(["other"]);
    physical.resolve();
    await Promise.all([next, retired.settlement]);
    expect(started).toEqual(["other", "next"]);
  } finally {
    physical.resolve();
    browser.resolve("done");
    sessions.clear();
  }
});
