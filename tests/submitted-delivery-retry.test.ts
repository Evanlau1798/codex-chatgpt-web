import { expect, test } from "bun:test";
import { StallTimeoutError } from "../src/stall-timeout";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { submittedBrowserFailure, submittedStallFailure } from "../src/adapters/chatgpt-web/submitted-turn";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import type { CodexParsedRequest, CodexToolResultMessage } from "../src/types";

const deliveryError = () => new ChatGptWebAdapterError("Message delivery timed out. Please try again.", {
  status: 503, errorType: "server_error", code: "chatgpt_delivery_timeout", retryable: true,
});

function fixture() {
  const session = new ChatGptTurnSession({
    mode: "tools", token: Promise.resolve("turn_delivery_test"), browser: new Promise(() => {}),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {},
    externalProgress: new ChatGptExternalTurnProgress(), submission: { phase: "accepted" },
  });
  const result: CodexToolResultMessage = {
    role: "toolResult", toolCallId: "call_delivery", toolName: "exec_command",
    content: "command executed once", isError: false, timestamp: 3,
  };
  const parsed: CodexParsedRequest = {
    modelId: "gpt-5.6-sol", stream: true, options: {}, _canonicalContextComplete: true,
    context: { messages: [
      { role: "assistant", content: [{ type: "toolCall", id: result.toolCallId,
        name: result.toolName, arguments: { cmd: "record-evidence" } }], timestamp: 2 }, result,
    ] },
  };
  session.setOutstanding([{ callId: result.toolCallId, wireName: result.toolName,
    arguments: { cmd: "record-evidence" }, freeform: false }]);
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

test.each(["aborted", "ambiguous", "incomplete", "final-streamed", "compaction", "manual", "superseded"] as const)(
  "canonical tool evidence cannot bypass the %s submission boundary", boundary => {
    const { session, parsed } = fixture();
    if (boundary === "ambiguous") session.runtime.submission!.phase = "send_activated";
    if (boundary === "incomplete") parsed._canonicalContextComplete = false;
    if (boundary === "final-streamed") session.runtime.text.push("Native final already delivered");
    if (boundary === "compaction") session.runtime.compactionRequested = true;
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
