import { expect, test } from "bun:test";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { submittedBrowserFailure } from "../src/adapters/chatgpt-web/submitted-turn";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";

function session(manual = false) {
  return new ChatGptTurnSession({
    mode: "read-only", browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {},
    submission: { phase: "accepted" },
    ...(manual ? { manualControl: { surfaceNonce: "test-surface-nonce" } } : {}),
  });
}

test("native reconnect replays one stable submitted failure without nesting its message", () => {
  const turn = session();
  const first = submittedBrowserFailure(turn, false, new Error("surface closed"))!;
  for (let i = 0; i < 6; i++) {
    const outcome = turn.settledOutcome();
    expect(outcome?.type).toBe("error");
    const replay = submittedBrowserFailure(turn, false, outcome?.type === "error" ? outcome.error : undefined);
    expect(replay).toBe(first);
    expect(replay!.message.match(/ChatGPT failed after accepting/g)).toHaveLength(1);
  }
});

test.each(["manual_handoff_timeout", "manual_turn_cancelled", "manual_launcher_failed"])(
  "accepted manual turn preserves authoritative %s instead of replacing it with an Automatic error",
  code => {
    const turn = session(true);
    const failure = new ChatGptWebAdapterError("Zero Risk terminal outcome", {
      status: 408, errorType: "invalid_request_error", code, retryable: false,
    });
    expect(submittedBrowserFailure(turn, false, failure)).toBe(failure);
    expect(turn.settledOutcome()).toEqual({ type: "error", error: failure });
  },
);
