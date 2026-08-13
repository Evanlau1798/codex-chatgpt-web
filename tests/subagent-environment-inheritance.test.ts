import { expect, test } from "bun:test";
import { completeChatGptToolResults } from "../src/adapters/chatgpt-web/tool-result-delivery";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import type { BrokerToolResult, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

test("inherits a spawned Codex agent before delivering its tool result", () => {
  const session = new ChatGptTurnSession({
    mode: "tools",
    browser: new Promise<string>(() => {}),
    token: Promise.resolve("turn-token"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => {},
  });
  session.setOutstanding([{
    callId: "call-spawn",
    wireName: "multi_agent_v1__spawn_agent",
    freeform: false,
  }]);
  const events: string[] = [];
  const broker = {
    completeTool(_token: string, _callId: string, _result: BrokerToolResult) { events.push("deliver"); },
  } as Pick<TurnBroker, "completeTool">;

  completeChatGptToolResults(session, broker, "turn-token", [{
    role: "toolResult",
    toolCallId: "call-spawn",
    toolName: "spawn_agent",
    content: JSON.stringify({ agent_id: "019ff0ff-1438-7a00-9aa2-0f1887d92a6c", nickname: "Faraday" }),
    isError: false,
    timestamp: 1,
  }], {
    onSpawnedCodexAgent(agentId) { events.push(`inherit:${agentId}`); },
  });

  expect(events).toEqual([
    "inherit:019ff0ff-1438-7a00-9aa2-0f1887d92a6c",
    "deliver",
  ]);
});

test("does not inherit malformed, failed, or non-spawn tool results", () => {
  for (const fixture of [
    { wireName: "multi_agent_v1__spawn_agent", content: "not-json", isError: false },
    { wireName: "multi_agent_v1__spawn_agent", content: JSON.stringify({ agent_id: "not-a-uuid" }), isError: false },
    { wireName: "multi_agent_v1__spawn_agent", content: JSON.stringify({ agent_id: "019ff0ff-1438-7a00-9aa2-0f1887d92a6c" }), isError: true },
    { wireName: "shell_command", content: JSON.stringify({ agent_id: "019ff0ff-1438-7a00-9aa2-0f1887d92a6c" }), isError: false },
  ]) {
    const session = new ChatGptTurnSession({
      mode: "tools",
      browser: new Promise<string>(() => {}),
      token: Promise.resolve("turn-token"),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => {},
    });
    session.setOutstanding([{ callId: "call", wireName: fixture.wireName, freeform: false }]);
    let inherited = 0;
    completeChatGptToolResults(session, { completeTool() {} }, "turn-token", [{
      role: "toolResult",
      toolCallId: "call",
      toolName: "tool",
      content: fixture.content,
      isError: fixture.isError,
      timestamp: 1,
    }], { onSpawnedCodexAgent() { inherited += 1; } });
    expect(inherited).toBe(0);
  }
});

test("retires a closed Codex agent before delivering its tool result", () => {
  const childThreadId = "019ff0ff-1438-7a00-9aa2-0f1887d92a6c";
  const session = new ChatGptTurnSession({
    mode: "tools",
    browser: new Promise<string>(() => {}),
    token: Promise.resolve("turn-token"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => {},
  });
  session.setOutstanding([{
    callId: "call-close",
    wireName: "multi_agent_v1__close_agent",
    freeform: false,
    arguments: { target: childThreadId },
  }]);
  const events: string[] = [];

  completeChatGptToolResults(session, {
    completeTool() { events.push("deliver"); },
  }, "turn-token", [{
    role: "toolResult",
    toolCallId: "call-close",
    toolName: "close_agent",
    content: JSON.stringify({ previous_status: "running" }),
    isError: false,
    timestamp: 1,
  }], {
    onClosedCodexAgent(agentId) { events.push(`retire:${agentId}`); },
  });

  expect(events).toEqual([`retire:${childThreadId}`, "deliver"]);
});
