import { expect, test } from "bun:test";
import { ChatGptWebAdapterError, chatGptCompletionEvidenceError, chatGptWebSurfaceError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptSurfaceRecoveryTracker, chatGptSameSurfaceRecoveryDecision, chatGptSurfaceRecoveryDecision } from "../src/adapters/chatgpt-web/runtime-lifecycle";
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

test("surface recovery diagnostics identify the error that reached the decision boundary", () => {
  const session = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve("turn_test"),
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => {},
  });
  session.observeCanonicalRequest(completeRequest());
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => warnings.push(values.map(String).join(" "));
  try {
    new ChatGptSurfaceRecoveryTracker("diagnostic-trace").recoverableResultCount(
      new DOMException("ChatGPT web turn aborted", "AbortError"),
      session,
      completeRequest(),
      0,
    );
  } finally {
    console.warn = originalWarn;
  }

  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("reason=unsupported_error");
  expect(warnings[0]).toContain("errorName=\"AbortError\"");
  expect(warnings[0]).toContain("errorCode=\"none\"");
  expect(warnings[0]).not.toContain("ChatGPT web turn aborted");
});

test("tool result delivery updates the live browser runtime state", () => {
  let delivered: CodexParsedRequest["context"]["messages"][number] | undefined;
  const session = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve("turn_test"),
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    onToolResultDelivered: result => { delivered = result; },
    cancel: () => {},
  });
  session.setOutstanding([{ callId: "call_1", wireName: "Read", freeform: false, arguments: {} }]);
  const result = {
    role: "toolResult" as const,
    toolCallId: "call_1",
    toolName: "Read",
    content: "The native tool returned an explicit policy rejection",
    isError: true,
    timestamp: 1,
  };

  session.markResultDelivered("call_1", result);

  expect(delivered).toEqual(result);
});

test("same-surface recovery requires complete canonical state and no pending effects", () => {
  const session = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve("turn_same_surface"),
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => {},
  });
  session.observeCanonicalRequest(completeRequest());
  const failure = chatGptCompletionEvidenceError("completion evidence disappeared", false);

  expect(chatGptSameSurfaceRecoveryDecision(failure, session, 1, true))
    .toMatchObject({ eligible: true, reason: "eligible" });
  expect(chatGptSameSurfaceRecoveryDecision(failure, session, 1, false))
    .toMatchObject({ eligible: false, reason: "mode_disabled" });
  expect(chatGptSameSurfaceRecoveryDecision(failure, session, 2, true))
    .toMatchObject({ eligible: false, reason: "already_recovered" });

  session.setOutstanding([{ callId: "call_pending", wireName: "exec_command", freeform: false, arguments: {} }]);
  expect(chatGptSameSurfaceRecoveryDecision(failure, session, 1, true))
    .toMatchObject({ eligible: false, reason: "tool_results_pending" });
});

test("same-surface recovery rejects partial final output, aborts, and unrelated failures", () => {
  const text = new ChatGptTextFeed();
  const session = new ChatGptTurnSession({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text,
    cancel: () => {},
  });
  session.observeCanonicalRequest(completeRequest());
  const failure = chatGptCompletionEvidenceError("completion evidence disappeared", false);
  const abort = new AbortController();
  abort.abort();

  expect(chatGptSameSurfaceRecoveryDecision(failure, session, 1, true, abort.signal))
    .toMatchObject({ eligible: false, reason: "aborted" });
  expect(chatGptSameSurfaceRecoveryDecision(chatGptWebSurfaceError("page closed", false), session, 1, true))
    .toMatchObject({ eligible: false, reason: "unsupported_error" });
  text.push("already delivered");
  expect(chatGptSameSurfaceRecoveryDecision(failure, session, 1, true))
    .toMatchObject({ eligible: false, reason: "final_streamed" });
});
