import { expect, test } from "bun:test";
import { claudeBrowserTurnOptions } from "../src/adapters/chatgpt-web/claude-subagent";
import { retainedConversationResumeRequest, sessionForChatGptRequest } from "../src/adapters/chatgpt-web/steering";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
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

test("completed Claude steering suppression follows a successful retained root session", async () => {
  const sessions = new ChatGptTurnSessions();
  let resolveFirst!: (answer: string) => void;
  const firstBrowser = new Promise<string>(resolve => { resolveFirst = resolve; });
  let starts = 0;
  const start = () => ({
    mode: "tools" as const,
    browser: starts++ === 0 ? firstBrowser : new Promise<string>(() => {}),
    token: Promise.resolve("turn-token"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel() {},
  });
  const setRevision = (parsed: CodexParsedRequest, text: string) => {
    const body = parsed._rawBody as Record<string, unknown>;
    body.input = [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn-current" },
    }];
  };
  const firstRequest = request({ claude_subagent: false, claude_retain_conversation: true });
  setRevision(firstRequest, "initial prompt");
  const first = await sessionForChatGptRequest(sessions, "claude-root", firstRequest, start);
  first.queueSteering("Apply the retained guidance", true, "delivery-1");
  first.acknowledgePendingClaudeSteering(1);
  resolveFirst("completed answer");
  await first.browserOutcome;

  const secondRequest = request({ claude_subagent: false, claude_retain_conversation: true });
  setRevision(secondRequest, "next prompt");
  const latest = secondRequest.context.messages.at(-1);
  if (latest?.role === "user") latest.content = "next prompt";
  const second = await sessionForChatGptRequest(sessions, "claude-root", secondRequest, start);

  expect(second).not.toBe(first);
  expect(second.claudeSteeringSuppressionCount("Apply the retained guidance")).toBe(1);
  sessions.clear();
});
