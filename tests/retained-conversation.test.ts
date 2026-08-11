import { expect, test } from "bun:test";
import { claudeBrowserTurnOptions } from "../src/adapters/chatgpt-web/claude-subagent";
import { retainedConversationResumeRequest } from "../src/adapters/chatgpt-web/steering";
import type { CodexParsedRequest } from "../src/types";

function request(clientMetadata: Record<string, unknown> = {}): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    context: {
      messages: [
        { role: "user", content: "old prompt", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "old answer" }], timestamp: 2 },
        { role: "user", content: "new prompt", timestamp: 3 },
      ],
    },
    options: { reasoning: "high" },
    _rawBody: {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread-retained",
          turn_id: "turn-current",
        }),
        ...clientMetadata,
      },
    },
  };
}

test("trusted Codex root and subagent threads retain their Web conversation", () => {
  expect(claudeBrowserTurnOptions(request()).retainConversation).toBeTrue();
  const compact = request();
  compact._compactionRequest = true;
  expect(claudeBrowserTurnOptions(compact).retainConversation).toBeFalse();
});

test("Claude root retention remains opt-in while Claude subagents stay isolated", () => {
  expect(claudeBrowserTurnOptions(request({
    claude_subagent: false,
    claude_retain_conversation: true,
  })).retainConversation).toBeTrue();
  expect(claudeBrowserTurnOptions(request({
    claude_subagent: true,
    claude_retain_conversation: true,
  })).retainConversation).toBeFalse();
});

test("retained conversations send only the suffix after the latest assistant turn", () => {
  expect(retainedConversationResumeRequest(request())?.context.messages).toEqual([
    { role: "user", content: "new prompt", timestamp: 3 },
  ]);
});
