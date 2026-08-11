import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { handleClaudeSteeringHook } from "../src/messages/steering-hook";
import {
  ChatGptSteeringFeed,
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSessions,
  chatGptTurnSteeringId,
} from "../src/adapters/chatgpt-web/turn-execution";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const turnId = `turn_steering_${Date.now()}`;
const threadId = `thread_steering_${Date.now()}`;

function request(...userPrompts: string[]): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    context: {
      messages: userPrompts.map((content, index) => ({ role: "user", content, timestamp: index + 1 })),
    },
    options: { reasoning: "high" },
    _rawBody: {
      prompt_cache_key: threadId,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
      },
      input: userPrompts.map(content => ({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: content }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      })),
    },
  };
}

test("continues queued prompts in the active Web conversation without replaying the harness", async () => {
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://steering-continuation-${Date.now()}`,
    chatgptWeb: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let browserStarts = 0;
  let activeTurn: BrowserTurn | undefined;
  let finishFirst: ((answer: string) => void) | undefined;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserStarts += 1;
    if (browserStarts > 1) {
      turn.onTextDelta("replacement answer");
      return "replacement answer";
    }
    activeTurn = turn;
    return new Promise<string>(resolve => { finishFirst = resolve; });
  };

  const events: AdapterEvent[][] = [[], [], []];
  const adapter = createChatGptWebAdapter(provider);
  const runs = [
    adapter.runTurn!(request("Inspect the repository"), { headers: new Headers() }, event => events[0]!.push(event)),
    adapter.runTurn!(request("Inspect the repository", "Prioritize correctness"), { headers: new Headers() }, event => events[1]!.push(event)),
    adapter.runTurn!(request("Inspect the repository", "Prioritize correctness", "Stop after five findings"), { headers: new Headers() }, event => events[2]!.push(event)),
  ];

  try {
    while (!activeTurn) await Bun.sleep(1);
    await Bun.sleep(10);
    const steering = await activeTurn.retryPromptForAnswer?.("Initial answer", 1);
    expect(steering).toContain("Prioritize correctness");
    expect(steering).toContain("Stop after five findings");
    expect(steering).not.toContain("<codex_context_json>");
    activeTurn.onTextDelta("updated answer");
    finishFirst?.("updated answer");
    await Promise.all(runs);
    expect(browserStarts).toBe(1);
    expect(events.every(stream => stream.at(-1)?.type === "done")).toBeTrue();
  } finally {
    finishFirst?.("updated answer");
    await Promise.allSettled(runs);
    worker.run = originalRun;
  }
});

test("routes a Claude UserPromptSubmit hook into the active root Web turn", async () => {
  const sessions = new ChatGptTurnSessions();
  const steering = new ChatGptSteeringFeed();
  const browser = new Promise<string>(() => {});
  sessions.getOrCreate("root", () => ({
    mode: "read-only",
    browser,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    steering,
    cancel: () => {},
  }), "claude_session-test", chatGptTurnSteeringId("claude_session-test", "dynamic-root-turn"), "claude_session-test");

  const response = await handleClaudeSteeringHook(new Request("http://localhost/v1/messages/steering", {
    method: "POST",
    body: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-test",
      prompt: "Please acknowledge this steering message",
    }),
  }), sessions);

  expect(response.status).toBe(204);
  expect(steering.take()).toBe("Please acknowledge this steering message");
});

test("routes queued Claude commands from tool hooks once and ignores stale transcript entries", async () => {
  const sessions = new ChatGptTurnSessions();
  const steering = new ChatGptSteeringFeed();
  const session = sessions.getOrCreate("root", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    steering,
    cancel: () => {},
  }), "claude_session-test", undefined, "claude_session-test");
  session.updateUserRevision("initial", "Initial prompt");
  const root = join(tmpdir(), `claude-steering-${process.pid}-${Date.now()}`);
  const transcriptPath = join(root, "session-test.jsonl");
  mkdirSync(root, { recursive: true });
  const queued = (content: string, timestamp: string) => JSON.stringify({
    type: "queue-operation",
    operation: "enqueue",
    timestamp,
    sessionId: "session-test",
    content,
  });
  writeFileSync(transcriptPath, [
    queued("Stale steering", "2020-01-01T00:00:00.000Z"),
    queued("First queued steering", new Date(Date.now() + 1).toISOString()),
    queued("Second queued steering", new Date(Date.now() + 2).toISOString()),
  ].join("\n"));
  const hook = () => new Request("http://localhost/v1/messages/steering", {
    method: "POST",
    body: JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: "session-test",
      transcript_path: transcriptPath,
    }),
  });

  try {
    expect((await handleClaudeSteeringHook(hook(), sessions)).status).toBe(204);
    expect(steering.take()).toBe("First queued steering\n\nSecond queued steering");
    expect(session.updateUserRevision("queued-replay", "First queued steering")).toBeUndefined();
    expect((await handleClaudeSteeringHook(hook(), sessions)).status).toBe(204);
    expect(steering.take()).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("routes Claude hook steering only to the active root when subagents share its session", async () => {
  const sessions = new ChatGptTurnSessions();
  const root = new ChatGptSteeringFeed();
  const children = Array.from({ length: 5 }, () => new ChatGptSteeringFeed());
  const runtime = (steering: ChatGptSteeringFeed) => ({
    mode: "read-only" as const,
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    steering,
    cancel: () => {},
  });
  sessions.getOrCreate("root", () => runtime(root), "claude_session-test", undefined, "claude_session-test");
  children.forEach((steering, index) => sessions.getOrCreate(
    `child-${index}`,
    () => runtime(steering),
    "claude_session-test",
    chatGptTurnSteeringId("claude_session-test", `claude_child-${index}`),
  ));

  await handleClaudeSteeringHook(new Request("http://localhost/v1/messages/steering", {
    method: "POST",
    body: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-test",
      prompt: "Root only",
    }),
  }), sessions);

  expect(root.take()).toBe("Root only");
  expect(children.every(steering => steering.take() === undefined)).toBeTrue();
});

test("fails closed for missing, subagent-only, or ambiguous Claude roots", async () => {
  const hook = () => new Request("http://localhost/v1/messages/steering", {
    method: "POST",
    body: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "session-test", prompt: "Do not misroute" }),
  });
  const runtime = (steering: ChatGptSteeringFeed) => ({
    mode: "read-only" as const,
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    steering,
    cancel: () => {},
  });
  const missing = new ChatGptTurnSessions();
  expect((await handleClaudeSteeringHook(hook(), missing)).status).toBe(204);

  const subagentOnly = new ChatGptTurnSessions();
  const child = new ChatGptSteeringFeed();
  subagentOnly.getOrCreate("child", () => runtime(child), "claude_session-test", "child");
  await handleClaudeSteeringHook(hook(), subagentOnly);
  expect(child.take()).toBeUndefined();

  const settled = new ChatGptTurnSessions();
  const settledRoot = new ChatGptSteeringFeed();
  settled.getOrCreate(
    "settled-root",
    () => ({ ...runtime(settledRoot), browser: Promise.resolve("done") }),
    "claude_session-test",
    undefined,
    "claude_session-test",
  );
  await Bun.sleep(0);
  await handleClaudeSteeringHook(hook(), settled);
  expect(settledRoot.take()).toBeUndefined();

  const ambiguous = new ChatGptTurnSessions();
  const roots = [new ChatGptSteeringFeed(), new ChatGptSteeringFeed()];
  roots.forEach((steering, index) => ambiguous.getOrCreate(
    `root-${index}`,
    () => runtime(steering),
    "claude_session-test",
    undefined,
    "claude_session-test",
  ));
  await handleClaudeSteeringHook(hook(), ambiguous);
  expect(roots.every(steering => steering.take() === undefined)).toBeTrue();
});

test("deduplicates a hooked Claude prompt when the transcript later replays it", async () => {
  const sessions = new ChatGptTurnSessions();
  const steering = new ChatGptSteeringFeed();
  const session = sessions.getOrCreate("root", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    steering,
    cancel: () => {},
  }), "claude_session-test", undefined, "claude_session-test");
  session.updateUserRevision("initial", "Initial prompt");

  for (const prompt of ["First steering", "Second steering"]) {
    await handleClaudeSteeringHook(new Request("http://localhost/v1/messages/steering", {
      method: "POST",
      body: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "session-test", prompt }),
    }), sessions);
  }
  expect(session.updateUserRevision("replayed", "First steering")).toBeUndefined();
  expect(steering.take()).toBe("First steering\n\nSecond steering");
  expect(session.updateUserRevision("replayed-again", "Second steering")).toBeUndefined();
  expect(steering.take()).toBeUndefined();
});
