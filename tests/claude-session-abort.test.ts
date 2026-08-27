import { expect, test } from "bun:test";
import { bindClaudeSessionAbort } from "../src/adapters/chatgpt-web/claude-subagent";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import type { CodexParsedRequest } from "../src/types";

test("Claude request abort retires its namespaced browser group", () => {
  const sessions = new ChatGptTurnSessions();
  const namespace = "provider-namespace";
  const threadId = "claude_session-test";
  let cancelled = 0;
  sessions.getOrCreate("root", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }), `${namespace}:${threadId}`);
  const parsed = {
    _rawBody: {
      client_metadata: {
        claude_subagent: false,
        "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: "claude_root" }),
      },
    },
  } as unknown as CodexParsedRequest;
  const abort = new AbortController();

  bindClaudeSessionAbort(parsed, abort.signal, sessions, namespace);
  abort.abort();

  expect(cancelled).toBe(1);
});
