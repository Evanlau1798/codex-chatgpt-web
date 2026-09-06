import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import type { CodexParsedRequest } from "../src/types";

const root = resolve(process.cwd());
const parentThreadId = "thread_parent";
const parentTurnId = "turn_parent";
const childThreadId = "thread_child";
const childTurnId = "turn_child";
const codexHome = resolve(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
const visualizationRoot = join(codexHome, "visualizations", "2026", "09", "07", parentThreadId);
const environment = `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root><root>${visualizationRoot}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`;
const item = (id: string, role: "developer" | "user", text: string, turnId: string) => ({
  type: "message",
  id,
  role,
  content: [{ type: "input_text", text }],
  internal_chat_message_metadata_passthrough: { turn_id: turnId },
});
const request = (
  threadId: string,
  turnId: string,
  input: Array<Record<string, unknown>>,
  parent?: string,
): CodexParsedRequest => ({
  modelId: "gpt-5.6-sol",
  stream: true,
  context: { messages: [], tools: [] },
  options: { reasoning: "high" },
  _rawBody: {
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        request_kind: "turn",
        thread_id: threadId,
        turn_id: turnId,
        ...(parent ? {
          parent_thread_id: parent,
          agent_name: "/root/reviewer",
          subagent_kind: "thread_spawn",
        } : {}),
        sandbox: "none",
        workspaces: { [root]: {} },
      }),
    },
    input,
  },
});

test("fork-context child accepts its inherited parent visualization root", () => {
  const parentInput = [
    item("msg_parent_environment", "user", environment, parentTurnId),
    item("msg_parent_prompt", "user", "Inspect the workspace.", parentTurnId),
  ];
  const store = new ChatGptThreadEnvironmentStore();
  const child = request(childThreadId, childTurnId, [
    ...parentInput,
    item("msg_child_developer", "developer", "Review only.", childTurnId),
    item("msg_child_prompt", "user", "Inspect the change.", childTurnId),
  ], parentThreadId);

  expect(store.resolve(child).cwd).toBe(root);
});
