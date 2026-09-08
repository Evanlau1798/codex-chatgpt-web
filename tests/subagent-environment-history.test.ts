import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import {
  chatGptTurnUserRevisionHistory,
  extractChatGptTurnEnvironment,
  extractChatGptTurnUserRevision,
} from "../src/adapters/chatgpt-web/environment";
import { parseRequest } from "../src/responses/parser";
import type { CodexParsedRequest } from "../src/types";
import { currentWire, dangerFullAccessProfileXml, root } from "./environment-fixture";

const metadata = (threadId: string, turnId: string, parentThreadId?: string) => ({
  client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({
      request_kind: "turn",
      thread_id: threadId,
      turn_id: turnId,
      ...(parentThreadId ? {
        parent_thread_id: parentThreadId,
        agent_name: "/root/reviewer",
        subagent_kind: "thread_spawn",
      } : {}),
      sandbox: "none",
      workspaces: { [root]: {} },
    }),
  },
});

test("uses inherited child authority when fork context contains only the parent environment", () => {
  const store = new ChatGptThreadEnvironmentStore();
  const codexHome = resolve(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
  const visualizationRoot = join(codexHome, "visualizations", "2026", "09", "07", "thread_current");
  const parent = currentWire({ environmentXml: `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root><root>${visualizationRoot}</root></workspace_roots>${dangerFullAccessProfileXml}</filesystem>
</environment_context>` });
  store.resolve(parent);
  expect(store.inherit("thread_current", "thread_child")).toBe(true);

  const parentInput = structuredClone((parent._rawBody as { input: Array<Record<string, unknown>> }).input);
  for (const item of parentInput) {
    item.internal_chat_message_metadata_passthrough = { turn_id: "turn_parent" };
  }
  const childTurnId = "turn_child";
  const child = {
    ...currentWire(),
    _rawBody: {
      ...metadata("thread_child", childTurnId, "thread_current"),
      input: [
        ...parentInput,
        {
          type: "message", id: "msg_child_developer", role: "developer",
          content: [{ type: "input_text", text: "Review only." }],
          internal_chat_message_metadata_passthrough: { turn_id: childTurnId },
        },
        {
          type: "message", id: "msg_child_prompt", role: "user",
          content: [{ type: "input_text", text: "Inspect the change." }],
          internal_chat_message_metadata_passthrough: { turn_id: childTurnId },
        },
      ],
    },
  } as CodexParsedRequest;

  expect(store.resolve(child).cwd).toBe(root);
});

test("does not hide a malformed current child environment behind inherited authority", () => {
  const store = new ChatGptThreadEnvironmentStore();
  store.resolve(currentWire());
  expect(store.inherit("thread_current", "thread_child")).toBe(true);
  const turnId = "turn_child";
  const child = {
    ...currentWire(),
    _rawBody: {
      ...metadata("thread_child", turnId, "thread_current"),
      input: [
        {
          type: "message", id: "msg_bad_environment", role: "user",
          content: [{ type: "input_text", text: "<environment_context><cwd></cwd></environment_context>" }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
        {
          type: "message", id: "msg_child_prompt", role: "user",
          content: [{ type: "input_text", text: "Continue." }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      ],
    },
  } as CodexParsedRequest;

  expect(() => store.resolve(child)).toThrow("missing cwd");
});

test("V2 accepts only direct-parent task revisions without changing native roles", () => {
  const childTurnId = "turn_child";
  const environmentItem = {
    type: "message", id: "msg_environment", role: "user",
    content: [{ type: "input_text", text: `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots>${dangerFullAccessProfileXml}</filesystem>
</environment_context>` }],
  };
  const task = {
    type: "agent_message", id: "amsg_task", author: "/root", recipient: "/root/reviewer",
    content: [{ type: "input_text", text: "Inspect the workspace." }],
  };
  const raw = {
    model: "chatgpt-web/high",
    ...metadata("thread_child", childTurnId, "thread_parent"),
    input: [environmentItem, task],
  };
  const parsed = parseRequest(raw);
  expect(extractChatGptTurnEnvironment(parsed).cwd).toBe(root);
  expect(extractChatGptTurnUserRevision(parsed)).toEqual(task.content);
  expect(parsed.context.messages.at(-1)?.role).toBe("agentMessage");
  expect(parsed._rawBody).toEqual(raw);

  const reply = { ...task, id: "amsg_reply", author: "/root/reviewer/worker",
    content: [{ type: "input_text", text: "Done." }] };
  for (const author of [reply.author, "/root/peer"]) {
    const continued = parseRequest({ ...raw, input: [environmentItem, task, { ...reply, author }] });
    expect(extractChatGptTurnUserRevision(continued)).toEqual(task.content);
    expect(chatGptTurnUserRevisionHistory(continued).map(revision => revision.itemId)).toEqual([task.id]);
  }
  const followup = { ...task, id: "amsg_followup",
    content: [{ type: "input_text", text: "Review the second file." }] };
  const continued = parseRequest({ ...raw, input: [environmentItem, task, reply, followup] });
  expect(extractChatGptTurnUserRevision(continued)).toEqual(followup.content);
  expect(chatGptTurnUserRevisionHistory(continued).map(revision => revision.itemId)).toEqual([task.id, followup.id]);

  for (const invalid of [
    { ...task, id: undefined }, { ...task, author: "/root/peer" },
    { ...task, recipient: "/root/other" }, { ...task, author: "/root/reviewer/worker" },
  ]) {
    const rejected = parseRequest({ ...raw, input: [environmentItem, invalid] });
    expect(() => extractChatGptTurnEnvironment(rejected)).toThrow("missing cwd");
    expect(() => extractChatGptTurnUserRevision(rejected)).toThrow("current-turn user message");
  }
  const stale = parseRequest({ ...raw, input: [environmentItem, {
    ...task, internal_chat_message_metadata_passthrough: { turn_id: "turn_parent" },
  }] });
  expect(() => extractChatGptTurnEnvironment(stale)).toThrow("missing cwd");
  expect(() => extractChatGptTurnUserRevision(stale)).toThrow("conflicts with native Codex turn_id");
  const turnMetadata = JSON.parse(raw.client_metadata["x-codex-turn-metadata"]);
  for (const changes of [
    { parent_thread_id: undefined }, { parent_thread_id: "thread_child" },
    { subagent_kind: undefined }, { agent_name: "/root" },
  ]) {
    const rejected = parseRequest({ ...raw, client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ ...turnMetadata, ...changes }),
    } });
    expect(() => extractChatGptTurnEnvironment(rejected)).toThrow("missing cwd");
    expect(() => extractChatGptTurnUserRevision(rejected)).toThrow("current-turn user message");
  }
  const restricted = parseRequest({ ...raw, client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({ ...turnMetadata, sandbox: "read-only" }),
  } });
  expect(() => extractChatGptTurnEnvironment(restricted)).toThrow("missing cwd");
});
