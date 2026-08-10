import { expect, test } from "bun:test";
import { chatGptWebSurfaceError } from "../src/adapters/chatgpt-web/adapter-error";
import { recoverableToolSurfaceResultCount } from "../src/adapters/chatgpt-web/runtime-lifecycle";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import type { CodexParsedRequest } from "../src/types";

function requestWithResults(callIds: string[]): CodexParsedRequest {
  return {
    modelId: "chatgpt-web/codex",
    stream: true,
    context: {
      tools: [],
      messages: callIds.map((toolCallId, index) => ({
        role: "toolResult" as const,
        toolCallId,
        toolName: "exec_command",
        content: `result-${index + 1}`,
        isError: false,
        timestamp: index + 1,
      })),
    },
    options: {},
  };
}

test("tool surface recovery requires one complete unstreamed batch and runs only once", () => {
  const text = new ChatGptTextFeed();
  const session = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve("turn_test"),
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text,
    usageInput: requestWithResults([]),
    cancel: () => {},
  });
  session.setOutstanding([
    { callId: "call_1", wireName: "exec_command", freeform: false, arguments: {} },
    { callId: "call_2", wireName: "exec_command", freeform: false, arguments: {} },
  ]);
  const failure = chatGptWebSurfaceError("surface changed", false);

  expect(recoverableToolSurfaceResultCount(failure, session, requestWithResults(["call_1"]), 0)).toBeUndefined();
  expect(recoverableToolSurfaceResultCount(failure, session, requestWithResults(["call_1", "call_2"]), 0)).toBe(2);
  expect(recoverableToolSurfaceResultCount(failure, session, requestWithResults(["call_1", "call_2"]), 1)).toBeUndefined();

  const abort = new AbortController();
  abort.abort();
  expect(recoverableToolSurfaceResultCount(
    failure,
    session,
    requestWithResults(["call_1", "call_2"]),
    0,
    abort.signal,
  )).toBeUndefined();

  text.push("partial answer");
  expect(recoverableToolSurfaceResultCount(failure, session, requestWithResults(["call_1", "call_2"]), 0)).toBeUndefined();
});
