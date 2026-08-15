import { expect, test } from "bun:test";
import { ChatGptWebAdapterError, chatGptWebSurfaceError } from "../src/adapters/chatgpt-web/adapter-error";
import { chatGptSurfaceRecoveryDecision } from "../src/adapters/chatgpt-web/runtime-lifecycle";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import type { CodexParsedRequest } from "../src/types";
import { StallTimeoutError } from "../src/stall-timeout";

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

function completeRequest(callIds: string[] = [], resultIds: string[] = []): CodexParsedRequest {
  const request = requestWithResults(resultIds);
  request._canonicalContextComplete = true;
  if (callIds.length > 0) {
    request.context.messages.unshift({
      role: "assistant",
      content: callIds.map(id => ({ type: "toolCall" as const, id, name: "exec_command", arguments: {} })),
      timestamp: 0,
    });
  }
  return request;
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
  const connectorFailure = new ChatGptWebAdapterError("connector unavailable", {
    status: 502,
    errorType: "server_error",
    code: "chatgpt_connector_unavailable",
    retryable: true,
    retireSession: true,
  });

  expect(chatGptSurfaceRecoveryDecision(failure, session, requestWithResults(["call_1"]), 0))
    .toMatchObject({ eligible: false, reason: "canonical_incomplete", canonicalResultCount: 1 });
  expect(chatGptSurfaceRecoveryDecision(failure, session, requestWithResults(["call_1", "call_2"]), 0))
    .toMatchObject({ eligible: false, reason: "canonical_incomplete", canonicalResultCount: 2 });
  expect(chatGptSurfaceRecoveryDecision(failure, session, completeRequest(["call_1", "call_2"], ["call_1"]), 0))
    .toMatchObject({ eligible: false, reason: "tool_results_incomplete", canonicalResultCount: 1 });
  expect(chatGptSurfaceRecoveryDecision(failure, session, completeRequest(["call_1", "call_2"], ["call_1", "call_2"]), 0))
    .toMatchObject({ eligible: true, reason: "eligible", canonicalResultCount: 2 });
  expect(chatGptSurfaceRecoveryDecision(failure, session, completeRequest(["call_1", "call_2"], ["call_1", "call_2"]), 1))
    .toMatchObject({ eligible: false, reason: "already_recovered" });
  expect(chatGptSurfaceRecoveryDecision(connectorFailure, session, completeRequest(["call_1", "call_2"], ["call_1", "call_2"]), 0))
    .toMatchObject({ eligible: true, reason: "eligible", canonicalResultCount: 2 });
  expect(chatGptSurfaceRecoveryDecision(
    new StallTimeoutError("no progress"),
    session,
    completeRequest(["call_1", "call_2"], ["call_1", "call_2"]),
    0,
  )).toMatchObject({ eligible: true, reason: "eligible", canonicalResultCount: 2 });

  const abort = new AbortController();
  abort.abort();
  expect(chatGptSurfaceRecoveryDecision(
    failure,
    session,
    completeRequest(["call_1", "call_2"], ["call_1", "call_2"]),
    0,
    abort.signal,
  )).toMatchObject({ eligible: false, reason: "aborted" });

  text.push("partial answer");
  expect(chatGptSurfaceRecoveryDecision(failure, session, completeRequest(["call_1", "call_2"], ["call_1", "call_2"]), 0))
    .toMatchObject({ eligible: false, reason: "final_streamed" });
});

test("surface recovery waits for superseded calls to receive canonical results", () => {
  const session = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve("turn_test"),
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: requestWithResults([]),
    cancel: () => {},
  });
  session.observeCanonicalRequest(completeRequest());
  session.setOutstanding([{ callId: "call_1", wireName: "exec_command", freeform: false, arguments: {} }]);
  session.observeCanonicalRequest(completeRequest(["call_1"]));
  session.supersedeOutstanding();
  const failure = chatGptWebSurfaceError("surface changed", false);

  expect(chatGptSurfaceRecoveryDecision(failure, session, completeRequest(["call_1"]), 0))
    .toMatchObject({ eligible: false, reason: "superseded_results_pending", unresolvedSupersededCount: 1 });
  session.observeCanonicalRequest(completeRequest(["call_1"], ["call_1"]));
  expect(chatGptSurfaceRecoveryDecision(failure, session, completeRequest(["call_1"], ["call_1"]), 0))
    .toMatchObject({ eligible: true, reason: "eligible", unresolvedSupersededCount: 0 });
});

test("surface recovery ignores a superseded call excluded by a newer complete canonical request", () => {
  const session = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve("turn_noncanonical"),
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => {},
  });
  session.observeCanonicalRequest(completeRequest());
  session.setOutstanding([{ callId: "call_not_accepted", wireName: "exec_command", freeform: false, arguments: {} }]);
  session.observeCanonicalRequest(completeRequest());
  session.supersedeOutstanding();

  expect(session.unresolvedSupersededResultIds()).toEqual([]);
  expect(chatGptSurfaceRecoveryDecision(
    chatGptWebSurfaceError("surface changed", false), session, completeRequest(), 0,
  )).toMatchObject({ eligible: true, reason: "eligible", unresolvedSupersededCount: 0 });
});

test("surface recovery rejects read-only and non-retryable turns", () => {
  const readOnly = new ChatGptTurnSession({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => {},
  });
  expect(chatGptSurfaceRecoveryDecision(
    chatGptWebSurfaceError("surface changed", false), readOnly, requestWithResults([]), 0,
  )).toMatchObject({ eligible: false, reason: "read_only" });

  const tools = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve("turn_test"),
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => {},
  });
  expect(chatGptSurfaceRecoveryDecision(
    chatGptWebSurfaceError("surface changed", true), tools, requestWithResults([]), 0,
  )).toMatchObject({ eligible: false, reason: "non_retryable" });
});

test("tool result delivery updates the live browser runtime state", () => {
  let delivered = false;
  const session = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve("turn_test"),
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    onToolResultDelivered: () => { delivered = true; },
    cancel: () => {},
  });
  session.setOutstanding([{ callId: "call_1", wireName: "Read", freeform: false, arguments: {} }]);

  session.markResultDelivered("call_1");

  expect(delivered).toBe(true);
});
