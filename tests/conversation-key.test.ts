import { expect, test } from "bun:test";
import { chatGptConversationKey, chatGptTurnTraceId } from "../src/adapters/chatgpt-web/turn-execution";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import type { CodexParsedRequest } from "../src/types";

function request(input: unknown[]): CodexParsedRequest {
  return {
    modelId: "chatgpt-web/medium",
    options: { reasoning: "medium" },
    _rawBody: {
      input,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-key-test", turn_id: "turn-key-test" }),
      },
    },
  } as unknown as CodexParsedRequest;
}

test("v1 compact replacement rotates the Web conversation once and then remains stable", () => {
  const before = request([{ type: "message", role: "user", content: [{ type: "input_text", text: "original task" }] }]);
  const compacted = request([{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\nretained handoff` }],
  }]);
  const continued = request([
    ...(compacted._rawBody as { input: unknown[] }).input,
    { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
  ]);

  expect(chatGptConversationKey(compacted, "provider")).not.toBe(chatGptConversationKey(before, "provider"));
  expect(chatGptConversationKey(continued, "provider")).toBe(chatGptConversationKey(compacted, "provider"));
  expect(chatGptTurnTraceId(compacted, "provider")).not.toBe(chatGptTurnTraceId(before, "provider"));
  expect(chatGptTurnTraceId(continued, "provider")).toBe(chatGptTurnTraceId(compacted, "provider"));
});
