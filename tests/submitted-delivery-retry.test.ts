import { expect, test } from "bun:test";
import { StallTimeoutError } from "../src/stall-timeout";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { submittedBrowserFailure, submittedStallFailure } from "../src/adapters/chatgpt-web/submitted-turn";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { namespacedToolName, type CodexParsedRequest, type CodexToolResultMessage } from "../src/types";

const deliveryError = () => new ChatGptWebAdapterError("Message delivery timed out. Please try again.", {
  status: 503, errorType: "server_error", code: "chatgpt_delivery_timeout", retryable: true,
});

function fixture(revision?: string, arguments_ = { cmd: "record-evidence" } as Record<string, unknown>,
  shape: { namespace?: string; freeform?: boolean } = {}) {
  const session = new ChatGptTurnSession({
    mode: "tools", token: Promise.resolve("turn_delivery_test"), browser: new Promise(() => {}),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {},
    externalProgress: new ChatGptExternalTurnProgress(), submission: { phase: "accepted" },
  });
  if (revision !== undefined) session.updateUserRevision(revision, revision, false);
  const result: CodexToolResultMessage = {
    role: "toolResult", toolCallId: "call_delivery", toolName: shape.freeform ? "exec" : "exec_command",
    ...(shape.namespace ? { toolNamespace: shape.namespace } : {}),
    content: "command executed once", isError: false, timestamp: 3,
  };
  const parsed: CodexParsedRequest = {
    modelId: "gpt-5.6-sol", stream: true, options: {}, _canonicalContextComplete: true,
    context: { messages: [
      { role: "assistant", content: [{ type: "toolCall", id: result.toolCallId,
        name: result.toolName, ...(shape.namespace ? { namespace: shape.namespace } : {}), arguments: structuredClone(arguments_) }], timestamp: 2 }, result,
    ] },
  };
  if (shape.freeform && typeof arguments_.input !== "string") throw new Error("Expected freeform input");
  session.setOutstanding([{ callId: result.toolCallId, wireName: namespacedToolName(shape.namespace, result.toolName),
    ...(shape.freeform ? { input: arguments_.input as string } : { arguments: structuredClone(arguments_) }), freeform: !!shape.freeform }]);
  session.observeCanonicalRequest(parsed);
  return { session, parsed, result };
}

for (const handler of [submittedBrowserFailure, submittedStallFailure]) {
  test(`${handler.name}: canonical delivery completion is the only submitted retry exception`, () => {
    const { session, parsed } = fixture();
    const failure = deliveryError();
    const classified = handler(session, false, failure, parsed);
    expect(classified).toBe(failure);
    expect(classified).toMatchObject({ code: "chatgpt_delivery_timeout", status: 503, retryable: true });
    expect(session.settledOutcome()).toBeUndefined();
    expect(session.outstanding()).toHaveLength(1);
  });
}

test.each(["missing", "duplicate", "active-excess"] as const)(
  "delivery pending safety rejects %s canonical results before any resend", scenario => {
    const { session, parsed, result } = fixture();
    if (scenario === "missing") parsed.context.messages.pop();
    if (scenario === "duplicate") parsed.context.messages.push(result);
    if (scenario === "active-excess") session.runtime.externalProgress!.recordToolBatch(1);
    session.observeCanonicalRequest(parsed);
    const failure = deliveryError();
    expect(submittedBrowserFailure(session, false, failure, parsed)).toMatchObject({
      code: "chatgpt_delivery_timeout", status: 503, retryable: false, cause: failure,
    });
    expect(session.settledOutcome()).toMatchObject({ type: "error", error: { retryable: false } });
  },
);

test.each(["aborted", "ambiguous", "incomplete", "final-streamed", "compaction", "local-compaction", "manual", "superseded"] as const)(
  "canonical tool evidence cannot bypass the %s submission boundary", boundary => {
    const { session, parsed } = fixture();
    if (boundary === "ambiguous") session.runtime.submission!.phase = "send_activated";
    if (boundary === "incomplete") parsed._canonicalContextComplete = false;
    if (boundary === "final-streamed") session.runtime.text.push("Native final already delivered");
    if (boundary === "compaction") session.runtime.compactionRequested = true;
    if (boundary === "local-compaction") parsed._localCompactionRequest = true;
    if (boundary === "manual") session.runtime.manualControl = { surfaceNonce: "manual" };
    if (boundary === "superseded") {
      session.supersedeOutstanding();
      parsed.context.messages.pop();
    }
    session.observeCanonicalRequest(parsed);
    expect(submittedBrowserFailure(session, boundary === "aborted", deliveryError(), parsed))
      .toMatchObject({ retryable: false });
  },
);

test("a stall preserves a settled delivery cause and its canonical result safety", () => {
  const { session, parsed } = fixture();
  const failure = deliveryError();
  session.setTerminalError(failure);
  expect(submittedStallFailure(session, false, new StallTimeoutError("observer stalled"), parsed))
    .toBe(failure);
});

test("a pending delivery receipt retains the original cause through the outer handler", () => {
  const { session, parsed } = fixture();
  parsed.context.messages.pop();
  const failure = deliveryError();
  const receipt = submittedBrowserFailure(session, false, failure, parsed)!;
  expect(submittedStallFailure(session, false, receipt, parsed)).toBe(receipt);
  expect(receipt.cause).toBe(failure);
});

test.each(["missing-delivered", "missing-other-call", "duplicate-delivered"] as const)(
  "a delivered tool count cannot authorize retry with %s canonical evidence", scenario => {
    const { session, parsed, result } = fixture();
    session.markResultDelivered(result.toolCallId, result);
    if (scenario === "missing-delivered") parsed.context.messages.pop();
    if (scenario === "duplicate-delivered") parsed.context.messages.push(result);
    if (scenario === "missing-other-call") parsed.context.messages.push({ role: "assistant", timestamp: 4,
      content: [{ type: "toolCall", id: "call_other", name: "exec_command", arguments: {} }] });
    session.observeCanonicalRequest(parsed);
    expect(submittedBrowserFailure(session, false, deliveryError(), parsed)).toMatchObject({ retryable: false });
  },
);

test.each(["upstream_server_error", "multipart_acknowledgement_mismatch"])(
  "canonical results never authorize retrying an accepted %s", code => {
    const { session, parsed } = fixture();
    const failure = new ChatGptWebAdapterError("other failure", {
      status: 502, errorType: "server_error", code, retryable: true,
    });
    expect(submittedBrowserFailure(session, false, failure, parsed)).toMatchObject({
      code: "chatgpt_submitted_turn_failed", retryable: false,
    });
  },
);

for (const handler of [submittedBrowserFailure, submittedStallFailure]) {
  test(`${handler.name}: a delivered A cannot borrow unrelated canonical B evidence`, () => {
    const { session, parsed, result } = fixture();
    session.markResultDelivered(result.toolCallId, result);
    parsed.context.messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "call_unrelated", name: "exec_command", arguments: {} }], timestamp: 4 },
      { ...result, toolCallId: "call_unrelated", content: "unrelated old output" },
    ];
    session.observeCanonicalRequest(parsed);
    expect(handler(session, false, deliveryError(), parsed)).toMatchObject({ retryable: false });
  });
}

test.each(["arguments", "content", "error-state", "tool-name", "namespace", "duplicate-call", "missing-call", "missing-receipt", "user-revision"] as const)(
  "delivery retry rejects mismatched %s evidence for the same call ID", scenario => {
    const { session, parsed, result } = fixture("work-a");
    session.markResultDelivered(result.toolCallId, scenario === "missing-receipt" ? undefined : result);
    const assistant = parsed.context.messages[0]!;
    if (assistant.role !== "assistant" || assistant.content[0]!.type !== "toolCall") throw new Error("Expected the emitted call");
    const call = assistant.content[0];
    if (scenario === "arguments") call.arguments = { cmd: "different-effect" };
    if (scenario === "content") result.content = "different output";
    if (scenario === "error-state") result.isError = true;
    if (scenario === "tool-name") call.name = result.toolName = "different_tool";
    if (scenario === "namespace") call.namespace = result.toolNamespace = "different_namespace";
    if (scenario === "duplicate-call") parsed.context.messages.push(structuredClone(assistant));
    if (scenario === "missing-call") parsed.context.messages.shift();
    if (scenario === "user-revision") session.updateUserRevision("work-b", "new user work", false);
    session.observeCanonicalRequest(parsed);
    expect(submittedBrowserFailure(session, false, deliveryError(), parsed)).toMatchObject({ retryable: false });
  },
);

test("matching canonical work survives a new observation, timestamp and JSON key order", () => {
  const { session, parsed, result } = fixture("same-work", { cmd: "record-evidence", workdir: "/workspace" });
  session.markResultDelivered(result.toolCallId, result);
  const assistant = parsed.context.messages[0]!;
  if (assistant.role !== "assistant" || assistant.content[0]!.type !== "toolCall") throw new Error("Expected the emitted call");
  assistant.content[0].arguments = { workdir: "/workspace", cmd: "record-evidence" };
  result.timestamp += 1;
  session.observeCanonicalRequest(parsed);
  expect(submittedBrowserFailure(session, false, deliveryError(), parsed)).toMatchObject({ retryable: true });
});

test.each(["namespaced", "freeform"] as const)("matching %s delivery retains canonical retry compatibility", shape => {
  const { session, parsed, result } = shape === "freeform"
    ? fixture("same-work", { input: "text('bounded probe')" }, { freeform: true })
    : fixture("same-work", { key: "value" }, { namespace: "mcp__fixture" });
  session.markResultDelivered(result.toolCallId, result);
  session.observeCanonicalRequest(parsed);
  expect(submittedBrowserFailure(session, false, deliveryError(), parsed)).toMatchObject({ retryable: true });
});

test("new user work may retry only after its own canonical tool evidence completes", () => {
  const { session, parsed, result } = fixture("work-a");
  session.markResultDelivered(result.toolCallId, result);
  session.updateUserRevision("work-b", "new work", false);
  const next = { ...result, toolCallId: "call_current", content: "current output" };
  session.setOutstanding([{ callId: next.toolCallId, wireName: next.toolName, arguments: { cmd: "current-evidence" }, freeform: false }]);
  parsed.context.messages.push({ role: "assistant", content: [{ type: "toolCall", id: next.toolCallId,
    name: next.toolName, arguments: { cmd: "current-evidence" } }], timestamp: 4 }, next);
  session.observeCanonicalRequest(parsed);
  session.markResultDelivered(next.toolCallId, next);
  expect(submittedBrowserFailure(session, false, deliveryError(), parsed)).toMatchObject({ retryable: true });
});

test("pending results cannot change the actual emitted call arguments", () => {
  const { session, parsed } = fixture();
  const assistant = parsed.context.messages[0]!;
  if (assistant.role !== "assistant" || assistant.content[0]!.type !== "toolCall") throw new Error("Expected the emitted call");
  assistant.content[0].arguments = { cmd: "different-effect" };
  session.observeCanonicalRequest(parsed);
  expect(submittedBrowserFailure(session, false, deliveryError(), parsed)).toMatchObject({ retryable: false });
});

test("canonical completeness requires matching foreign call/result IDs, not equal counts", () => {
  const { session, parsed, result } = fixture();
  session.markResultDelivered(result.toolCallId, result);
  parsed.context.messages.push({ role: "assistant", content: [{ type: "toolCall", id: "foreign-call", name: "exec_command", arguments: {} }], timestamp: 5 },
    { ...result, toolCallId: "different-foreign-result" });
  session.observeCanonicalRequest(parsed);
  expect(submittedBrowserFailure(session, false, deliveryError(), parsed)).toMatchObject({ retryable: false });
});
