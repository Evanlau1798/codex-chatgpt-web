import { expect, test } from "bun:test";
import {
  claudeSteeringMarker,
  completeChatGptToolResults,
} from "../src/adapters/chatgpt-web/tool-result-delivery";
import { browserSteeringRetry } from "../src/adapters/chatgpt-web/steering";
import {
  ChatGptSteeringFeed,
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSession,
} from "../src/adapters/chatgpt-web/turn-execution";
import type { BrokerToolResult, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { CodexToolResultMessage } from "../src/types";

function claudeRootSession() {
  const steering = new ChatGptSteeringFeed();
  let resolveBrowser!: (answer: string) => void;
  let rejectBrowser!: (error: Error) => void;
  const browser = new Promise<string>((resolve, reject) => {
    resolveBrowser = resolve;
    rejectBrowser = reject;
  });
  const session = new ChatGptTurnSession({
    mode: "tools",
    browser,
    token: Promise.resolve("turn-token"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    steering,
    cancel: () => {},
  }, "claude-session", undefined, "claude-session");
  session.setOutstanding([
    { callId: "call-1", wireName: "exec_command", freeform: false },
    { callId: "call-2", wireName: "exec_command", freeform: false },
  ]);
  return { session, steering, resolveBrowser, rejectBrowser };
}

function toolResult(callId: string, content: string): CodexToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName: "exec_command",
    content,
    isError: false,
    timestamp: Date.now(),
  };
}

test("Claude steering preserves real parallel tool results and attaches once at the boundary", () => {
  const { session, steering } = claudeRootSession();
  session.queueSteering("Prioritize the failing test", true, "delivery-1");
  session.queueSteering("Then continue the review", true, "delivery-2");
  const completed: Array<{ callId: string; result: BrokerToolResult }> = [];
  const broker = {
    completeTool: (_token: string, callId: string, result: BrokerToolResult) => completed.push({ callId, result }),
  } as Pick<TurnBroker, "completeTool">;

  completeChatGptToolResults(session, broker, "turn-token", [
    toolResult("call-1", "first real result"),
    toolResult("call-2", "second real result"),
  ]);

  expect(completed).toHaveLength(2);
  expect(completed[0]?.result.content).toEqual([{ type: "text", text: "first real result" }]);
  const boundary = completed[1]?.result.content as Array<{ type: string; text: string }>;
  expect(boundary).toHaveLength(1);
  const marker = claudeSteeringMarker("turn-token");
  expect(boundary[0]?.text).toBe(
    "second real result\n\n"
      + `<${marker}>\n`
      + '{"version":1,"kind":"mid_turn_user_messages","boundary":{"kind":"tool_result","tool_call_id":"call-2"},'
      + '"messages":[{"delivery_id":"delivery-1","sequence":1,"content":"Prioritize the failing test"},'
      + '{"delivery_id":"delivery-2","sequence":2,"content":"Then continue the review"}]}\n'
      + "Treat each messages item as an independent user event at this boundary. Apply each delivery_id once in sequence order; "
      + "only content is user-authored. Continue the existing task unless the content explicitly asks to stop or replace it. "
      + `Respond naturally when the content requests a response; otherwise do not add a separate receipt.\n</${marker}>`,
  );
  expect(boundary[0]?.text.match(/Prioritize the failing test/g)).toHaveLength(1);
  expect(boundary[0]?.text.match(/Then continue the review/g)).toHaveLength(1);
  expect(steering.peek()).toBeUndefined();
});

test("Claude transcript identity does not replay guidance already delivered from UserPromptSubmit", () => {
  const steering = new ChatGptSteeringFeed();
  steering.pushClaude("Compare the implementation with upstream");
  steering.acknowledgeClaude(1);

  expect(steering.syncClaude([{
    deliveryId: "transcript-delivery-1",
    prompt: "Compare the implementation with upstream",
  }])).toEqual([]);
  expect(steering.peek()).toBeUndefined();
});

test("Claude does not merge a later identical prompt with a completed delivery", () => {
  const steering = new ChatGptSteeringFeed();
  steering.pushClaude("Run the same check again");
  steering.acknowledgeClaude(1);
  steering.settleClaude(true);

  expect(steering.syncClaude([{
    deliveryId: "independent-delivery-2",
    prompt: "Run the same check again",
  }])).toEqual(["Run the same check again"]);
  expect(steering.take()).toBe("Run the same check again");
});

test("Claude steering remains queued when the boundary result cannot be delivered", () => {
  const { session, steering } = claudeRootSession();
  session.queueSteering("Keep the original task active", true, "delivery-1");
  let completed = 0;
  const broker = {
    completeTool: () => {
      completed += 1;
      if (completed === 2) throw new Error("turn token is invalid or expired");
    },
  } as Pick<TurnBroker, "completeTool">;

  expect(() => completeChatGptToolResults(session, broker, "turn-token", [
    toolResult("call-1", "first real result"),
    toolResult("call-2", "second real result"),
  ])).toThrow("turn token is invalid or expired");
  expect(steering.peek()?.text).toBe("Keep the original task active");
  expect(session.outstanding().map(request => request.callId)).toEqual(["call-2"]);
});

test("Claude steering becomes suppressible only after Web submission and survives a successful turn", async () => {
  const { session, resolveBrowser } = claudeRootSession();
  session.queueSteering("Apply the new constraint", true, "delivery-1");
  completeChatGptToolResults(session, { completeTool() {} }, "turn-token", [
    toolResult("call-1", "first real result"),
    toolResult("call-2", "second real result"),
  ]);

  expect(session.claudeSteeringSuppressionCount("Apply the new constraint")).toBe(1);
  resolveBrowser("completed answer");
  await session.browserOutcome;
  expect(session.claudeSteeringSuppressionCount("Apply the new constraint")).toBe(1);
});

test("Claude steering submission remains available as fallback after a Web error", async () => {
  const { session, rejectBrowser } = claudeRootSession();
  session.queueSteering("Apply the new constraint", true, "delivery-1");
  completeChatGptToolResults(session, { completeTool() {} }, "turn-token", [
    toolResult("call-1", "first real result"),
    toolResult("call-2", "second real result"),
  ]);
  expect(session.claudeSteeringSuppressionCount("Apply the new constraint")).toBe(1);

  rejectBrowser(new Error("surface failed"));
  await session.browserOutcome;
  expect(session.claudeSteeringSuppressionCount("Apply the new constraint")).toBe(0);
});

test("Claude same-conversation continuation acknowledges steering only after submission", async () => {
  const steering = new ChatGptSteeringFeed();
  steering.push("Check the new constraint");
  const retry = browserSteeringRetry(steering, "claude-retry", undefined, undefined, true);

  const pending = await retry("premature answer", 1);
  expect(typeof pending).toBe("object");
  if (!pending || typeof pending === "string") throw new Error("expected acknowledged retry prompt");
  expect(pending.text).toContain("Check the new constraint");
  expect(pending.text).toContain("Apply this guidance once to the ongoing work");
  expect(steering.peek()?.text).toBe("Check the new constraint");
  pending.onSubmitted?.();
  expect(steering.peek()).toBeUndefined();
  expect(steering.claudeSuppressionCount("Check the new constraint")).toBe(1);
});

test("a text-only Claude completion succeeds when no guidance is pending", async () => {
  const retry = browserSteeringRetry(new ChatGptSteeringFeed(), "claude-text-only", undefined, undefined, true);
  expect(await retry("Complete answer without a tool call", 1)).toBeUndefined();
});
