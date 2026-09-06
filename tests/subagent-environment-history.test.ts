import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
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
