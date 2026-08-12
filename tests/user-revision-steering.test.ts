import { expect, test } from "bun:test";
import { extractChatGptTurnUserText } from "../src/adapters/chatgpt-web/environment";
import {
  ChatGptSteeringFeed,
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSessions,
} from "../src/adapters/chatgpt-web/turn-execution";
import type { CodexParsedRequest } from "../src/types";

test("does not treat Codex subagent notifications as user steering", () => {
  const turnId = "turn-root";
  const message = (text: string) => ({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });
  const parsed = {
    modelId: "chatgpt-web/medium",
    stream: true,
    context: { systemPrompt: [], tools: [], messages: [] },
    options: {},
    _rawBody: {
      prompt_cache_key: "thread-root",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-root", turn_id: turnId }),
      },
      input: [
        message("Original task"),
        message("Apply this steering"),
        message('<subagent_notification>{"agent_path":"child","status":{"completed":"done"}}</subagent_notification>'),
      ],
    },
  } satisfies CodexParsedRequest;

  expect(extractChatGptTurnUserText(parsed)).toBe("Apply this steering");
});

test("does not redeliver a native revision after a transient transcript rollback", () => {
  const sessions = new ChatGptTurnSessions();
  const steering = new ChatGptSteeringFeed();
  const session = sessions.getOrCreate("root", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    steering,
    cancel: () => {},
  }));

  expect(session.updateUserRevision("revision-a", "Initial prompt")).toBeUndefined();
  expect(session.updateUserRevision("revision-b", "Steering prompt")).toBe("Steering prompt");
  expect(steering.take()).toBe("Steering prompt");
  expect(session.updateUserRevision("revision-a", "Initial prompt")).toBeUndefined();
  expect(session.updateUserRevision("revision-b", "Steering prompt")).toBeUndefined();
  expect(steering.take()).toBeUndefined();
});
