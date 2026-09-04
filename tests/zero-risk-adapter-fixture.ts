import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import { defaultBrokerEndpoint } from "../src/config";
import type { CodexParsedRequest, CodexProviderConfig } from "../src/types";

const testTempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
export const root = mkdtempSync(join(testTempRoot, "cgw-zero-risk-adapter-"));
afterAll(() => {
  chatGptTurnSessions.clear();
  rmSync(root, { recursive: true, force: true });
});

export function request(turnId: string): CodexParsedRequest {
  const threadId = "thread_safe_adapter";
  const environment = `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`;
  return {
    modelId: CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL,
    stream: true,
    options: { reasoning: "low" },
    context: {
      tools: [],
      messages: [
        { role: "developer", content: environment, timestamp: 1 },
        { role: "user", content: "Inspect the Zero Risk transport.", timestamp: 2 },
      ],
    },
    _rawBody: {
      prompt_cache_key: threadId,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
      },
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: environment }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Inspect the Zero Risk transport." }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      ],
    },
  };
}

export function binding(prompt: string): { request_id: string } {
  const match = prompt.match(/<codex_zero_risk_request_json>\n(\{[^\n]+\})\n<\/codex_zero_risk_request_json>/);
  if (!match) throw new Error("Zero Risk prompt did not expose its request id");
  return JSON.parse(match[1]!) as { request_id: string };
}

export function provider(name: string): CodexProviderConfig {
  return {
    adapter: "chatgpt-web",
    baseUrl: `manual://${name}-${Date.now()}`,
    chatgptWeb: {
      appName: "Codex Zero Risk",
      browserInteractionMode: "manual",
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, `${name}-launcher.json`),
      brokerSocketPath: defaultBrokerEndpoint(join(root, name)),
      localToolsEnabled: true,
      solAvailable: false,
      proAvailable: false,
      experimentalBiggerContext: false,
    },
  };
}

export function noManualTerminal(): Promise<never> {
  return new Promise<never>(() => {});
}
