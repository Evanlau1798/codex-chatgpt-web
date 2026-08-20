import { expect, test } from "bun:test";
import {
  claudeSteeringMarker,
  completeChatGptToolResults,
} from "../src/adapters/chatgpt-web/tool-result-delivery";
import { claudeAgentMessagingOptions } from "../src/adapters/chatgpt-web/claude-agent-messaging";
import { claudeAgentTurnId } from "../src/claude-session-identity";
import { browserSteeringRetry } from "../src/adapters/chatgpt-web/steering";
import {
  chatGptTurnSteeringId,
  ChatGptSteeringFeed,
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSession,
  ChatGptTurnSessions,
} from "../src/adapters/chatgpt-web/turn-execution";
import type { BrokerToolResult, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { CodexToolResultMessage } from "../src/types";
import type { CodexParsedRequest } from "../src/types";

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
      + '"messages":[{"delivery_id":"delivery-1","sequence":1,"source":"user","content":"Prioritize the failing test"},'
      + '{"delivery_id":"delivery-2","sequence":2,"source":"user","content":"Then continue the review"}]}\n'
      + "Treat each messages item as independent guidance at this boundary. Apply each delivery_id once in sequence order; "
      + "source identifies whether content came from the user or the coordinating agent. Continue the existing task unless the content explicitly asks to stop or replace it. "
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

test("Claude late transcript identity binds the submitted provisional before an identical queued delivery", () => {
  const steering = new ChatGptSteeringFeed();
  steering.pushClaude("Run the same check");
  steering.acknowledgeClaude(1);
  steering.pushClaude("Run the same check");

  expect(steering.pushClaude("Run the same check", "first-delivery-id")).toBe(false);
  expect(steering.peek()).toMatchObject({
    count: 1,
    messages: [{ content: "Run the same check" }],
  });
  expect(steering.peek()?.messages[0]?.deliveryId).not.toBe("first-delivery-id");
});

test("Claude transcript sync retains a valid provisional delivery until its identity is visible", () => {
  const steering = new ChatGptSteeringFeed();
  steering.pushClaude("Transcript has not flushed yet");

  expect(steering.syncClaude([])).toEqual([]);
  expect(steering.peek()?.text).toBe("Transcript has not flushed yet");
  expect(steering.syncClaude([], Date.now() + 1_000)).toEqual([]);
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

test("Claude SendMessage reaches the active child at its next real tool-result boundary", () => {
  const sessions = new ChatGptTurnSessions();
  const threadId = "claude_session-1";
  const agentId = "agent-1";
  const child = sessions.getOrCreate(
    "child",
    () => ({
      mode: "tools",
      browser: new Promise<string>(() => {}),
      token: Promise.resolve("child-token"),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => {},
    }),
    threadId,
    chatGptTurnSteeringId(threadId, claudeAgentTurnId(agentId)),
  );
  child.setOutstanding([{ callId: "child-tool", wireName: "Read", freeform: false }]);

  const root = new ChatGptTurnSession({
    mode: "tools",
    browser: new Promise<string>(() => {}),
    token: Promise.resolve("root-token"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => {},
  }, threadId, undefined, threadId);
  root.setOutstanding([{ callId: "send-message", wireName: "SendMessage", freeform: false, arguments: {
    to: agentId,
    summary: "add final assertion",
    message: "Also report the final test name",
  } }]);
  const parsed = {
    _rawBody: { client_metadata: { claude_subagent: false } },
    context: { messages: [] },
    modelId: "gpt-5.6-sol",
    options: {},
  } as unknown as CodexParsedRequest;
  Object.assign(parsed._rawBody as object, {
    client_metadata: {
      claude_subagent: false,
      "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: "claude_root" }),
    },
  });

  completeChatGptToolResults(root, { completeTool() {} }, "root-token", [
    toolResult("send-message", '{"success":true,"message":"queued"}'),
  ], claudeAgentMessagingOptions(parsed, sessions));

  const completed: Array<{ callId: string; result: BrokerToolResult }> = [];
  completeChatGptToolResults(child, {
    completeTool: (_token, callId, result) => completed.push({ callId, result }),
  }, "child-token", [toolResult("child-tool", "real child result")]);

  const text = (completed[0]?.result.content as Array<{ text?: string }>)[0]?.text ?? "";
  expect(text).toContain("real child result");
  expect(text.match(/Also report the final test name/g)).toHaveLength(1);
  expect(text).toContain('"source":"coordinator"');
  expect(text).not.toContain("only content is user-authored");
  expect(child.peekPendingSteering()).toBeUndefined();
});

test("Claude child routing waits until the SendMessage result reaches the active Web turn", () => {
  const root = new ChatGptTurnSession({
    mode: "tools",
    browser: new Promise<string>(() => {}),
    token: Promise.resolve("root-token"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => {},
  }, "claude-session", undefined, "claude-session");
  root.setOutstanding([{ callId: "send-message", wireName: "SendMessage", freeform: false, arguments: {
    to: "agent-1",
    message: "Apply the added check",
  } }]);
  let routed = 0;

  expect(() => completeChatGptToolResults(root, {
    completeTool() { throw new Error("turn token is invalid or expired"); },
  }, "root-token", [toolResult("send-message", '{"success":true}')], {
    onClaudeAgentMessage() { routed += 1; },
  })).toThrow("turn token is invalid or expired");

  expect(routed).toBe(0);
});
