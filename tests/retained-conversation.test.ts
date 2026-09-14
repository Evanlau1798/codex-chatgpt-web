import { expect, test } from "bun:test";
import { claudeBrowserTurnOptions } from "../src/adapters/chatgpt-web/claude-subagent";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { retainedConversationResumeRequest, sessionForChatGptRequest } from "../src/adapters/chatgpt-web/steering";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { estimateTokens } from "../src/lib/token-estimate";
import type { CodexParsedRequest } from "../src/types";

function request(clientMetadata: Record<string, unknown> = {}): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    context: {
      messages: [
        { role: "user", content: "old prompt", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "old answer" }], timestamp: 2 },
        { role: "user", content: "new prompt", timestamp: 3 },
      ],
    },
    options: { reasoning: "high" },
    _rawBody: {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread-retained",
          turn_id: "turn-current",
        }),
        ...clientMetadata,
      },
    },
  };
}

function setRevision(parsed: CodexParsedRequest, text: string): void {
  const body = parsed._rawBody as Record<string, unknown>;
  body.input = [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn-current" },
  }];
}

function setCanonicalModelSwitch(parsed: CodexParsedRequest, switchTurnId: string, userText: string): void {
  const body = parsed._rawBody as Record<string, unknown>;
  body.input = [
    {
      type: "message",
      role: "developer",
      id: `switch-${switchTurnId}`,
      content: [
        { type: "input_text", text: "<model_switch>Use the selected model.</model_switch>" },
        { type: "input_text", text: "<app-context>Keep the trusted context.</app-context>" },
      ],
      internal_chat_message_metadata_passthrough: {
        turn_id: switchTurnId,
        create_time: 1,
        content_item_kinds: ["model_switch.instructions", "generic.developer_instructions"],
      },
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: userText }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn-current" },
    },
  ];
}

test("trusted Codex root and subagent threads retain their Web conversation", () => {
  expect(claudeBrowserTurnOptions(request()).retainConversation).toBeTrue();
  const compact = request();
  compact._compactionRequest = true;
  expect(claudeBrowserTurnOptions(compact).retainConversation).toBeFalse();
});

test("Claude root and subagent retention remain opt-in", () => {
  expect(claudeBrowserTurnOptions(request({
    claude_subagent: false,
    claude_retain_conversation: true,
  })).retainConversation).toBeTrue();
  expect(claudeBrowserTurnOptions(request({
    claude_subagent: true,
    claude_retain_conversation: true,
  })).retainConversation).toBeTrue();
});

test("Claude subagent conversation keys include the stable agent identity", () => {
  const root = request({ claude_subagent: false, claude_retain_conversation: true });
  const child = request({
    claude_subagent: true,
    claude_retain_conversation: true,
    "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-retained", turn_id: "claude_child-a" }),
  });
  const sameChild = structuredClone(child);
  const otherChild = request({
    claude_subagent: true,
    claude_retain_conversation: true,
    "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-retained", turn_id: "claude_child-b" }),
  });

  expect(chatGptConversationKey(child, "messages")).toBe(chatGptConversationKey(sameChild, "messages"));
  expect(chatGptConversationKey(child, "messages")).not.toBe(chatGptConversationKey(root, "messages"));
  expect(chatGptConversationKey(child, "messages")).not.toBe(chatGptConversationKey(otherChild, "messages"));
});

test("retained conversations send only the suffix after the latest assistant turn", () => {
  expect(retainedConversationResumeRequest(request())?.context.messages).toEqual([
    { role: "user", content: "new prompt", timestamp: 3 },
  ]);
});

test("retained prompts omit stable system instructions but preserve the current turn contract", () => {
  const parsed = request();
  const systemSentinel = Array.from({ length: 1_200 }, (_unused, index) => `stable-system-${index}`).join(" ");
  const environment = "<environment_context><cwd>C:/current-work</cwd></environment_context>";
  parsed.context.systemPrompt = [systemSentinel];
  parsed.context.tools = [{ name: "Read", description: "Read a file", parameters: {} }];
  parsed.context.messages = [
    { role: "user", content: `old-history-${"x".repeat(100_000)}`, timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "old answer" }], timestamp: 2 },
    { role: "developer", content: environment, timestamp: 3 },
    { role: "user", content: "latest-user-sentinel", timestamp: 4 },
  ];
  parsed.options.verbosity = "high";
  parsed.options.outputFormat = {
    type: "json_schema",
    name: "retained_result",
    strict: true,
    schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
  };
  const resume = retainedConversationResumeRequest(parsed)!;
  const capabilities = { localToolsEnabled: true, solAvailable: true, proAvailable: true };
  const oldToken = "turn_12345678901234567890123456789012";
  const currentToken = "turn_abcdefghijklmnopqrstuvwxyz123456";

  expect(resume.context.systemPrompt).toBeUndefined();
  expect(resume.context.messages).toEqual(parsed.context.messages.slice(2));
  expect(resume._retainedConversationResume).toBeTrue();
  for (const manualControl of [false, true]) {
    const options = manualControl ? { manualControl: true as const } : undefined;
    const full = compileChatGptWebPrompt(parsed, capabilities, oldToken, options);
    const incremental = compileChatGptWebPrompt(resume, capabilities, currentToken, options);
    expect(full.text).toContain(systemSentinel);
    expect(full.text).toContain("Read the complete inline JSON task context before acting.");
    expect(incremental.text).not.toContain(systemSentinel);
    expect(incremental.text).not.toContain("Read the complete inline JSON task context before acting.");
    expect(incremental.text).toContain("Read the incremental inline JSON task context before continuing.");
    expect(incremental.text).toContain("The retained conversation and this turn's incremental context are complete.");
    expect(incremental.text).not.toContain("old-history-");
    expect(incremental.text).toContain(environment);
    expect(incremental.text).toContain("latest-user-sentinel");
    expect(incremental.text).toContain("Read");
    expect(incremental.text).toContain("retained_result");
    expect(incremental.text).toContain(currentToken);
    expect(incremental.text).not.toContain(oldToken);
    expect(incremental.text.length).toBeLessThan(full.text.length * 0.3);
    expect(estimateTokens(incremental.text)).toBeLessThan(estimateTokens(full.text) * 0.3);
    expect(new Set(Array.from({ length: 100 }, () => (
      compileChatGptWebPrompt(resume, capabilities, currentToken, options).text.length
    ))).size).toBe(1);
  }
});

test("completed Claude steering suppression follows a successful retained root session", async () => {
  const sessions = new ChatGptTurnSessions();
  let resolveFirst!: (answer: string) => void;
  const firstBrowser = new Promise<string>(resolve => { resolveFirst = resolve; });
  let starts = 0;
  let releases = 0;
  const firstRequest = request({ claude_subagent: false, claude_retain_conversation: true });
  const conversationKey = chatGptConversationKey(firstRequest, "messages");
  const start = () => ({
    mode: "tools" as const,
    browser: starts++ === 0 ? firstBrowser : new Promise<string>(() => {}),
    token: Promise.resolve("turn-token"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey,
    release: async () => { releases += 1; },
    cancel() {},
  });
  setRevision(firstRequest, "initial prompt");
  const first = await sessionForChatGptRequest(
    sessions, "claude-root", firstRequest, start, "messages",
  );
  first.queueSteering("Apply the retained guidance", true, "delivery-1");
  first.acknowledgePendingClaudeSteering(1);
  resolveFirst("completed answer");
  await first.browserOutcome;

  const secondRequest = request({ claude_subagent: false, claude_retain_conversation: true });
  setRevision(secondRequest, "next prompt");
  secondRequest.context.messages = [
    { role: "user", content: "initial prompt", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "tool-1", name: "Read", arguments: {} }],
      timestamp: 2,
    },
    { role: "toolResult", toolCallId: "tool-1", toolName: "Read", content: "read result", isError: false, timestamp: 3 },
    { role: "assistant", content: [{ type: "text", text: "completed answer" }], timestamp: 4 },
    { role: "user", content: "next prompt", timestamp: 5 },
  ];
  const second = await sessionForChatGptRequest(
    sessions, "claude-root", secondRequest, start, "messages",
  );

  expect(second).not.toBe(first);
  expect(releases).toBe(0);
  expect(second.claudeSteeringSuppressionCount("Apply the retained guidance")).toBe(1);
  const toolResult = secondRequest.context.messages.find(message => message.role === "toolResult");
  expect(JSON.stringify(toolResult?.content).match(/Apply the retained guidance/g)).toHaveLength(1);
  expect(JSON.stringify(toolResult?.content)).toContain("Historical mid-turn user guidance (already applied):");
  expect(retainedConversationResumeRequest(secondRequest)?.context.messages).toEqual([
    { role: "user", content: "next prompt", timestamp: 5 },
  ]);
  sessions.clear();
});

test("replacing a settled session releases a retained surface when its conversation identity changes", async () => {
  const sessions = new ChatGptTurnSessions();
  let resolveFirst!: (answer: string) => void;
  let releases = 0;
  let starts = 0;
  const firstBrowser = new Promise<string>(resolve => { resolveFirst = resolve; });
  const firstRequest = request({ claude_subagent: false, claude_retain_conversation: true });
  const oldConversationKey = chatGptConversationKey(firstRequest, "messages");
  const start = () => ({
    mode: "tools" as const,
    browser: starts++ === 0 ? firstBrowser : new Promise<string>(() => {}),
    token: Promise.resolve("turn-token"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey: oldConversationKey,
    release: async () => { releases += 1; },
    cancel() {},
  });
  setRevision(firstRequest, "initial prompt");
  const first = await sessionForChatGptRequest(
    sessions, "claude-root-changed", firstRequest, start, "messages",
  );
  resolveFirst("completed answer");
  await first.browserOutcome;

  const secondRequest = request({ claude_subagent: false, claude_retain_conversation: true });
  secondRequest.options.reasoning = "medium";
  setRevision(secondRequest, "next prompt");
  await sessionForChatGptRequest(
    sessions, "claude-root-changed", secondRequest, start, "messages",
  );

  expect(releases).toBe(1);
  sessions.clear();
});

test("canonical model switching retires the prior native-thread surface before starting the replacement", async () => {
  const sessions = new ChatGptTurnSessions();
  let settleOld!: () => void;
  const oldSettlement = new Promise<void>(resolve => { settleOld = resolve; });
  let starts = 0;
  let cancellations = 0;
  let releases = 0;
  const firstRequest = request();
  setRevision(firstRequest, "initial Web turn");
  const oldConversationKey = chatGptConversationKey(firstRequest, "provider");
  const first = await sessionForChatGptRequest(sessions, "old-owner", firstRequest, () => ({
    mode: "tools" as const,
    browser: Promise.resolve("old answer"),
    physicalSettlement: oldSettlement,
    token: Promise.resolve("old-token"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey: oldConversationKey,
    release: async () => { releases += 1; },
    cancel: () => { cancellations += 1; },
  }), "provider");
  starts += 1;
  await first.browserOutcome;

  sessions.getOrCreate("unrelated-owner", () => ({
    mode: "read-only" as const,
    browser: Promise.resolve("unrelated answer"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey: "unrelated-conversation",
    nativeIdentity: { threadId: "other-thread", turnId: "other-turn" },
    cancel() {},
  }));

  const switchedRequest = request();
  setCanonicalModelSwitch(switchedRequest, "switch-generation-one", "continue after switching");
  const switchedConversationKey = chatGptConversationKey(switchedRequest, "provider");
  expect(switchedConversationKey).not.toBe(oldConversationKey);
  const replacement = sessionForChatGptRequest(sessions, "new-owner", switchedRequest, () => {
    starts += 1;
    return {
      mode: "tools" as const,
      browser: Promise.resolve("new answer"),
      token: Promise.resolve("new-token"),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      conversationKey: switchedConversationKey,
      cancel() {},
    };
  }, "provider");

  await Promise.resolve();
  expect(starts).toBe(1);
  expect(cancellations).toBe(1);
  expect(releases).toBe(0);
  expect(sessions.find("unrelated-owner")).toBeDefined();

  settleOld();
  const replacementSession = await replacement;
  expect(starts).toBe(2);
  expect(releases).toBe(1);
  expect(await (replacementSession.runtime.mode === "tools" ? replacementSession.runtime.token : undefined))
    .toBe("new-token");

  const sameGeneration = structuredClone(switchedRequest);
  setCanonicalModelSwitch(sameGeneration, "switch-generation-one", "continue in the same Web generation");
  expect(chatGptConversationKey(sameGeneration, "provider")).toBe(switchedConversationKey);
  sessions.clear();
});

test("active Claude root transcript revisions do not become duplicate steering", async () => {
  const sessions = new ChatGptTurnSessions();
  const start = () => ({
    mode: "tools" as const,
    browser: new Promise<string>(() => {}),
    token: Promise.resolve("turn-token"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel() {},
  });
  const firstRequest = request({ claude_subagent: false, claude_retain_conversation: true });
  setRevision(firstRequest, "initial prompt");
  const session = await sessionForChatGptRequest(sessions, "claude-root-active", firstRequest, start);
  const nextRequest = request({ claude_subagent: false, claude_retain_conversation: true });
  setRevision(nextRequest, "transcript changed after a tool result");

  expect(await sessionForChatGptRequest(sessions, "claude-root-active", nextRequest, start)).toBe(session);
  expect(session.peekPendingSteering()).toBeUndefined();
  sessions.clear();
});

test("groups Codex sessions by their trusted thread identity", async () => {
  const sessions = new ChatGptTurnSessions();
  const parsed = request();
  setRevision(parsed, "initial prompt");
  let cancelled = 0;
  await sessionForChatGptRequest(sessions, "codex-root", parsed, () => ({
    mode: "tools" as const,
    browser: new Promise<string>(() => {}),
    token: Promise.resolve("turn-token"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel() { cancelled += 1; },
  }), "provider-a");

  expect(sessions.retireGroup("provider-a:thread-retained")).toBe(1);
  expect(sessions.retireGroup("provider-b:thread-retained")).toBe(0);
  expect(cancelled).toBe(1);
});

test("links a trusted Codex child thread to its parent session group", async () => {
  const sessions = new ChatGptTurnSessions();
  const parsed = request({
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: "child-thread",
      parent_thread_id: "root-thread",
      turn_id: "turn-current",
    }),
  });
  setRevision(parsed, "child task");
  let cancelled = 0;
  sessions.linkAgentReference("provider-a:root-thread", "/root/worker");
  await sessionForChatGptRequest(sessions, "codex-child", parsed, () => ({
    mode: "tools" as const,
    browser: new Promise<string>(() => {}),
    token: Promise.resolve("turn-token"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel() { cancelled += 1; },
  }), "provider-a");

  expect(sessions.retireAgentReference("provider-a:root-thread", "/root/worker", false)).toBe(1);
  expect(cancelled).toBe(1);
});

test("retires a closed Codex agent group and all descendant groups", () => {
  const sessions = new ChatGptTurnSessions();
  const cancelled: string[] = [];
  for (const group of ["provider:child", "provider:grandchild", "other:child"]) {
    sessions.getOrCreate(group, () => ({
      mode: "read-only",
      browser: new Promise<string>(() => {}),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel() { cancelled.push(group); },
    }), group);
  }
  sessions.linkGroups("provider:root", "provider:child");
  sessions.linkGroups("provider:child", "provider:grandchild");

  expect(sessions.retireGroupTree("provider:child")).toBe(2);
  expect(cancelled).toEqual(["provider:child", "provider:grandchild"]);
});
