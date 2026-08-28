import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { extractChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import type { CodexParsedRequest } from "../src/types";

const workspace = resolve(process.cwd());

function requestWithVisualizationRoot(root: string): CodexParsedRequest {
  const environment = `<environment_context>
  <cwd>${workspace}</cwd>
  <filesystem><workspace_roots><root>${workspace}</root><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`;
  const metadata = {
    thread_id: "thread_current",
    turn_id: "turn_current",
    sandbox: "none",
    workspaces: { [workspace]: { has_changes: true } },
  };
  const owned = { internal_chat_message_metadata_passthrough: { turn_id: "turn_current" } };
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    context: { messages: [{ role: "user", content: "Inspect", timestamp: 1 }] },
    options: { reasoning: "high" },
    _rawBody: {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
      input: [
        {
          type: "message",
          id: "msg_context",
          role: "user",
          content: [{ type: "input_text", text: environment }],
          ...owned,
        },
        {
          type: "message",
          id: "msg_active",
          role: "user",
          content: [{ type: "input_text", text: "Inspect" }],
          ...owned,
        },
        {
          type: "message",
          id: "msg_skill",
          role: "user",
          content: [{ type: "input_text", text: "<skill name=\"autopilot\">Use this skill.</skill>" }],
          ...owned,
        },
      ],
    },
  };
}

test("skill recovery trusts only the current thread visualization root", () => {
  const codexHome = resolve(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
  const current = join(codexHome, "visualizations", "2026", "08", "28", "thread_current");
  const other = join(codexHome, "visualizations", "2026", "08", "28", "thread_other");

  expect(extractChatGptTurnEnvironment(requestWithVisualizationRoot(current)).roots)
    .toEqual([workspace, current]);
  expect(() => extractChatGptTurnEnvironment(requestWithVisualizationRoot(other)))
    .toThrow("missing cwd");
});
