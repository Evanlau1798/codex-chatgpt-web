import { expect, test } from "bun:test";
import { chatGptConversationKey, chatGptTurnTraceId } from "../src/adapters/chatgpt-web/turn-execution";
import { retainedConversationResumeRequest } from "../src/adapters/chatgpt-web/steering";
import { translateClaudeMessages } from "../src/messages/request";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import { parseRequest } from "../src/responses/parser";
import type { CodexParsedRequest } from "../src/types";

function request(input: unknown[]): CodexParsedRequest {
  return {
    modelId: "chatgpt-web/medium",
    context: { messages: [] },
    stream: true,
    options: { reasoning: "medium" },
    _rawBody: {
      input,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-key-test", turn_id: "turn-key-test" }),
      },
    },
  } as unknown as CodexParsedRequest;
}

function claudeRequest(anchor: string, subagent = false): CodexParsedRequest {
  const parsed = request([{ type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }]);
  const raw = parsed._rawBody as { client_metadata: Record<string, unknown> };
  raw.client_metadata.claude_subagent = subagent;
  raw.client_metadata.claude_history_anchor = anchor;
  return parsed;
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

test("Claude canonical history replacement rotates its retained Web conversation", () => {
  const before = claudeRequest("history-before");
  const continued = claudeRequest("history-before");
  const replaced = claudeRequest("history-after");

  expect(chatGptConversationKey(continued, "provider")).toBe(chatGptConversationKey(before, "provider"));
  expect(chatGptConversationKey(replaced, "provider")).not.toBe(chatGptConversationKey(before, "provider"));
  expect(chatGptTurnTraceId(replaced, "provider")).not.toBe(chatGptTurnTraceId(before, "provider"));
});

test("Claude subagent partial-history resume keeps its retained Web conversation", () => {
  const initial = claudeRequest("initial-child-request", true);
  const resumed = claudeRequest("resume-slice-only", true);

  expect(chatGptConversationKey(resumed, "provider")).toBe(chatGptConversationKey(initial, "provider"));
  expect(chatGptTurnTraceId(resumed, "provider")).toBe(chatGptTurnTraceId(initial, "provider"));
});

test("retained conversation keys bind the ordered system prompt contract", () => {
  const parsed = request([]);
  parsed.context = { systemPrompt: ["system-one", "system-two"], messages: [] };
  const same = structuredClone(parsed);

  expect(chatGptConversationKey(same, "provider")).toBe(chatGptConversationKey(parsed, "provider"));
  for (const systemPrompt of [
    ["system-one"],
    ["system-two", "system-one"],
    ["system-one", "system-edited"],
    ["system-one", "system-two", "system-three"],
  ]) {
    const changed = structuredClone(parsed);
    changed.context.systemPrompt = systemPrompt;
    expect(chatGptConversationKey(changed, "provider")).not.toBe(chatGptConversationKey(parsed, "provider"));
  }
});

test("Codex Desktop prompt cache identity survives turn-local base instruction changes", () => {
  const desktopRequest = (instructions: string, promptCacheKey = "codex-session-key") => parseRequest({
    model: "chatgpt-web/medium",
    instructions,
    prompt_cache_key: promptCacheKey,
    reasoning: { effort: "medium" },
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: "desktop-thread", turn_id: "desktop-turn" }),
    },
    input: [
      { type: "message", role: "user", content: "original task" },
      { type: "message", role: "assistant", content: "previous answer" },
      { type: "message", role: "developer", content: "current developer context" },
      { type: "message", role: "user", content: "current user request" },
    ],
  });
  const parsed = desktopRequest("desktop-base-one");
  const changedInstructions = desktopRequest("desktop-base-two");

  expect(chatGptConversationKey(changedInstructions, "provider"))
    .toBe(chatGptConversationKey(parsed, "provider"));
  expect(retainedConversationResumeRequest(changedInstructions)?.context.messages.map(message => message.role))
    .toEqual(["developer", "user"]);
  expect(chatGptConversationKey(desktopRequest("desktop-base-two", "other-codex-session-key"), "provider"))
    .not.toBe(chatGptConversationKey(parsed, "provider"));
});

test("Claude system changes rotate despite its transport prompt cache key", () => {
  const headers = new Headers({
    "x-claude-code-session-id": "claude-system-session",
    "x-claude-code-agent-id": "claude-system-agent",
  });
  const claudeRequest = (system: string) => parseRequest(translateClaudeMessages({
    model: "chatgpt-web/medium",
    system,
    messages: [{ role: "user", content: "continue" }],
  }, headers).body);

  expect(chatGptConversationKey(claudeRequest("system-one"), "messages"))
    .not.toBe(chatGptConversationKey(claudeRequest("system-two"), "messages"));
});
