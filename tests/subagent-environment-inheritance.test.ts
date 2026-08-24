import { expect, test } from "bun:test";
import { completeChatGptToolResults } from "../src/adapters/chatgpt-web/tool-result-delivery";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession, ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import type { BrokerToolResult, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

test("inherits a spawned Codex agent before delivering its tool result", async () => {
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

  await completeChatGptToolResults(session, broker, "turn-token", [{
    role: "toolResult",
    toolCallId: "call-spawn",
    toolName: "spawn_agent",
    content: JSON.stringify({ agent_id: "019ff0ff-1438-7a00-9aa2-0f1887d92a6c", nickname: "Faraday" }),
    isError: false,
    timestamp: 1,
  }], {
    onSpawnedCodexAgent(agent) { events.push(`inherit:${agent.threadId}`); },
  });

  expect(events).toEqual([
    "inherit:019ff0ff-1438-7a00-9aa2-0f1887d92a6c",
    "deliver",
  ]);
});

test("does not inherit malformed, failed, or non-spawn tool results", async () => {
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
    await completeChatGptToolResults(session, { completeTool() {} }, "turn-token", [{
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

test("retires a closed Codex agent before delivering its tool result", async () => {
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
  const sessions = new ChatGptTurnSessions();
  sessions.getOrCreate("provider:child", () => ({
    mode: "read-only", browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    cancel: () => events.push("cancel:child"),
  }), "provider:child");
  sessions.getOrCreate("provider:grandchild", () => ({
    mode: "read-only", browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    cancel: () => events.push("cancel:grandchild"),
  }), "provider:grandchild");
  sessions.linkGroups("provider:child", "provider:grandchild");
  const events: string[] = [];

  await completeChatGptToolResults(session, {
    completeTool() { events.push("deliver"); },
  }, "turn-token", [{
    role: "toolResult",
    toolCallId: "call-close",
    toolName: "close_agent",
    content: JSON.stringify({ previous_status: "running" }),
    isError: false,
    timestamp: 1,
  }], {
    onClosedCodexAgent(agent) {
      events.push(`retire:${agent.reference}`);
      sessions.retireGroupTree(`provider:${agent.reference === childThreadId ? "child" : agent.reference}`);
    },
  });

  expect(events).toEqual([`retire:${childThreadId}`, "cancel:child", "cancel:grandchild", "deliver"]);
});

test("binds a native V2 task path to its child session before delivering spawn", async () => {
  const parentGroup = "provider:root-thread";
  const childGroup = "provider:child-thread";
  const sessions = new ChatGptTurnSessions();
  const events: string[] = [];
  sessions.getOrCreate("child-turn", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => events.push("cancel:child"),
  }), childGroup);
  sessions.linkGroups(parentGroup, childGroup);

  const session = new ChatGptTurnSession({
    mode: "tools",
    browser: new Promise<string>(() => {}),
    token: Promise.resolve("turn-token"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => {},
  });
  session.setOutstanding([{
    callId: "call-v2-spawn",
    wireName: "collaboration__spawn_agent",
    freeform: false,
    arguments: { task_name: "worker", message: "bounded task" },
  }]);

  await completeChatGptToolResults(session, {
    completeTool() { events.push("deliver"); },
  }, "turn-token", [{
    role: "toolResult",
    toolCallId: "call-v2-spawn",
    toolName: "spawn_agent",
    content: JSON.stringify({ task_name: "/root/worker" }),
    isError: false,
    timestamp: 1,
  }], {
    onSpawnedCodexAgent(agent) {
      events.push(`link:${agent.reference}`);
      sessions.linkAgentReference(parentGroup, agent.reference);
    },
  });

  expect(events).toEqual(["link:/root/worker", "deliver"]);
  expect(sessions.retireAgentReference(parentGroup, "/root/worker", false)).toBe(1);
  expect(events).toEqual(["link:/root/worker", "deliver", "cancel:child"]);
});

test("accepts an unambiguous relative native V2 agent reference", () => {
  const sessions = new ChatGptTurnSessions();
  let cancelled = 0;
  sessions.getOrCreate("child-turn", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }), "provider:child");
  sessions.linkGroups("provider:root", "provider:child");
  sessions.linkAgentReference("provider:root", "/root/worker");

  expect(sessions.retireAgentReference("provider:root", "worker", false)).toBe(1);
  expect(cancelled).toBe(1);
});

test("retires only the interrupted native V2 child before delivering its result", async () => {
  const parentGroup = "provider:root-thread";
  const childGroup = "provider:child-thread";
  const grandchildGroup = "provider:grandchild-thread";
  const sessions = new ChatGptTurnSessions();
  const events: string[] = [];
  for (const [key, group] of [["child-turn", childGroup], ["grandchild-turn", grandchildGroup]] as const) {
    sessions.getOrCreate(key, () => ({
      mode: "read-only",
      browser: new Promise<string>(() => {}),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => events.push(`cancel:${group}`),
    }), group);
  }
  sessions.linkGroups(parentGroup, childGroup);
  sessions.linkGroups(childGroup, grandchildGroup);
  sessions.linkAgentReference(parentGroup, "/root/worker");

  const session = new ChatGptTurnSession({
    mode: "tools",
    browser: new Promise<string>(() => {}),
    token: Promise.resolve("turn-token"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => {},
  });
  session.setOutstanding([{
    callId: "call-v2-interrupt",
    wireName: "collaboration__interrupt_agent",
    freeform: false,
    arguments: { target: "/root/worker" },
  }]);

  await completeChatGptToolResults(session, {
    completeTool() { events.push("deliver"); },
  }, "turn-token", [{
    role: "toolResult",
    toolCallId: "call-v2-interrupt",
    toolName: "interrupt_agent",
    content: JSON.stringify({ previous_status: "running" }),
    isError: false,
    timestamp: 1,
  }], {
    onInterruptedCodexAgent(agent) {
      events.push(`interrupt:${agent.reference}`);
      sessions.retireAgentReference(parentGroup, agent.reference, false);
    },
  });

  expect(events).toEqual([
    "interrupt:/root/worker",
    `cancel:${childGroup}`,
    "deliver",
  ]);
  expect(sessions.retireGroup(grandchildGroup)).toBe(1);
});

test("does not guess native V2 task paths when sibling bindings are ambiguous", () => {
  const sessions = new ChatGptTurnSessions();
  const cancelled: string[] = [];
  for (const child of ["child-a", "child-b"]) {
    sessions.getOrCreate(child, () => ({
      mode: "read-only",
      browser: new Promise<string>(() => {}),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => cancelled.push(child),
    }), `provider:${child}`);
    sessions.linkGroups("provider:root", `provider:${child}`);
  }
  sessions.linkAgentReference("provider:root", "/root/worker-a");
  sessions.linkAgentReference("provider:root", "/root/worker-b");

  expect(sessions.retireAgentReference("provider:root", "/root/worker-a", false)).toBe(0);
  expect(cancelled).toEqual([]);
  sessions.clear();
});
