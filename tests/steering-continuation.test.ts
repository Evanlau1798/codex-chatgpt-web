import { expect, test } from "bun:test";
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
  }), undefined, chatGptTurnSteeringId("claude_session-test", "claude_root"));

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
