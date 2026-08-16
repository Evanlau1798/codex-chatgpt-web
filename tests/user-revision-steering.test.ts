import { expect, test } from "bun:test";
import { extractChatGptTurnUserText } from "../src/adapters/chatgpt-web/environment";
import {
  ChatGptSteeringFeed,
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSessions,
} from "../src/adapters/chatgpt-web/turn-execution";
import type { CodexParsedRequest } from "../src/types";

function contextualGoalTurn(currentTurnId: string, goalTurnId = currentTurnId): CodexParsedRequest {
  const goal = '<codex_internal_context source="goal">\nContinue the active goal.\n</codex_internal_context>';
  return {
    modelId: "chatgpt-web/extra-high",
    stream: true,
    context: { systemPrompt: [], tools: [], messages: [] },
    options: {},
    _rawBody: {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-root", turn_id: currentTurnId }),
      },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Original task" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-previous" },
      }, {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Previous turn completed" }],
      }, {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: goal }],
        internal_chat_message_metadata_passthrough: { turn_id: goalTurnId },
      }],
    },
  } satisfies CodexParsedRequest;
}

test("uses a contextual-only goal message as the current native turn revision", () => {
  const parsed = contextualGoalTurn("turn-goal");

  expect(extractChatGptTurnUserText(parsed)).toBe(
    '<codex_internal_context source="goal">\nContinue the active goal.\n</codex_internal_context>',
  );
});

test("does not authorize a contextual goal message owned by another native turn", () => {
  const parsed = contextualGoalTurn("turn-goal", "turn-foreign");

  expect(() => extractChatGptTurnUserText(parsed)).toThrow(/current-turn user message|conflicts with native Codex turn_id/);
});

test("does not treat Codex subagent notifications as user steering", () => {
  const turnId = "turn-root";
  const message = (text: string) => ({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });
  const parsed = {
    modelId: "chatgpt-web/medium",
    stream: true,
    context: { systemPrompt: [], tools: [], messages: [] },
    options: {},
    _rawBody: {
      prompt_cache_key: "thread-root",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-root", turn_id: turnId }),
      },
      input: [
        message("Original task"),
        message("Apply this steering"),
        message('<subagent_notification>{"agent_path":"child","status":{"completed":"done"}}</subagent_notification>'),
      ],
    },
  } satisfies CodexParsedRequest;

  expect(extractChatGptTurnUserText(parsed)).toBe("Apply this steering");
});

test("does not treat Codex contextual user fragments as steering", () => {
  const turnId = "turn-root";
  const message = (content: Array<{ type: "input_text"; text: string }>) => ({
    type: "message",
    role: "user",
    content,
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });
  const parsed = {
    modelId: "chatgpt-web/medium",
    stream: true,
    context: { systemPrompt: [], tools: [], messages: [] },
    options: {},
    _rawBody: {
      prompt_cache_key: "thread-root",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-root", turn_id: turnId }),
      },
      input: [
        message([{ type: "input_text", text: "Original task" }]),
        message([
          { type: "input_text", text: "<RECOMMENDED_PLUGINS>\nplugins\n</recommended_plugins>" },
          { type: "input_text", text: "<turn_aborted>\ninterrupted\n</turn_aborted>" },
        ]),
        message([{ type: "input_text", text: "# AGENTS.md instructions for G:\\\n\n<INSTRUCTIONS>\nrules\n</INSTRUCTIONS>" }]),
        message([{ type: "input_text", text: "<skill>\n<name>demo</name>\n</skill>" }]),
        message([{ type: "input_text", text: "<user_shell_command>\n<command>pwd</command>\n</user_shell_command>" }]),
        message([{ type: "input_text", text: "<codex_internal_context source=\"extension\">\nstate\n</codex_internal_context>" }]),
      ],
    },
  } satisfies CodexParsedRequest;

  expect(extractChatGptTurnUserText(parsed)).toBe("Original task");
});

test("ignores a user message when any content part is contextual", () => {
  const turnId = "turn-root";
  const parsed = {
    modelId: "chatgpt-web/medium",
    stream: true,
    context: { systemPrompt: [], tools: [], messages: [] },
    options: {},
    _rawBody: {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-root", turn_id: turnId }),
      },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Original user prompt" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }, {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "This part must not become steering" },
          { type: "input_text", text: "<turn_aborted>interrupted</turn_aborted>" },
        ],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }],
    },
  } satisfies CodexParsedRequest;

  expect(extractChatGptTurnUserText(parsed)).toBe("Original user prompt");
});

test("does not redeliver a native revision after a transient transcript rollback", () => {
  const sessions = new ChatGptTurnSessions();
  const steering = new ChatGptSteeringFeed();
  const session = sessions.getOrCreate("root", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    steering,
    cancel: () => {},
  }));

  expect(session.updateUserRevision("revision-a", "Initial prompt")).toBeUndefined();
  expect(session.updateUserRevision("revision-b", "Steering prompt")).toBe("Steering prompt");
  expect(steering.take()).toBe("Steering prompt");
  expect(session.updateUserRevision("revision-a", "Initial prompt")).toBeUndefined();
  expect(session.updateUserRevision("revision-b", "Steering prompt")).toBeUndefined();
  expect(steering.take()).toBeUndefined();
});
