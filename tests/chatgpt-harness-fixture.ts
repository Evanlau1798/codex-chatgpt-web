import { afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import type { BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import type { CodexParsedRequest, CodexTool } from "../src/types";

export const tempRoot = join(tmpdir(), `codex-chatgpt-web-harness-${process.pid}-${Date.now()}`);
mkdirSync(tempRoot, { recursive: true });
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

export const tools: CodexTool[] = [
  { name: "exec", description: "Run nested Codex tools", parameters: {}, freeform: true },
  { name: "exec_command", description: "Run command", parameters: { type: "object" } },
  { name: "write_stdin", description: "Continue command", parameters: { type: "object" } },
  { name: "apply_patch", description: "Patch files", parameters: {}, freeform: true },
  { name: "view_image", description: "View image", parameters: { type: "object" } },
  { name: "search_openai_docs", namespace: "mcp__openaiDeveloperDocs", description: "Search docs", parameters: { type: "object" } },
];

export const environmentXml = `<environment_context>
  <cwd>${tempRoot}</cwd>
  <filesystem><workspace_roots><root>${tempRoot}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`;
export function brokerTestEndpoint(name: string): string {
  return process.platform === "win32"
    ? defaultBrokerEndpoint(join(tmpdir(), name), "win32")
    : join(tmpdir(), `${name}.sock`);
}

export async function beginAcknowledgedToolInvocation<T>(
  turn: BrowserTurn,
  invoke: () => Promise<T>,
): Promise<{ result: Promise<T> }> {
  const progress = turn.externalProgress;
  if (!progress) throw new Error("tool-capable browser has no progress transport");
  const previousBatchRevision = progress.snapshot().lastToolBatchRevision;
  const result = invoke();
  let snapshot = progress.snapshot();
  while (snapshot.lastToolBatchRevision <= previousBatchRevision) {
    snapshot = await progress.waitForChange(snapshot.revision, turn.abortSignal);
  }
  await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
  return { result };
}

export function toolResult(value: Record<string, unknown>): BrokerToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

export function parsed(developerText?: string): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    context: {
      tools,
      messages: [
        ...(developerText ? [{ role: "developer" as const, content: developerText, timestamp: 1 }] : []),
        { role: "user", content: "Inspect the project", timestamp: 2 },
      ],
    },
    options: { reasoning: "high" },
  };
}

export function rawWireRequest(environmentText: string): CodexParsedRequest {
  const request = parsed();
  const turnId = "turn_test_123";
  const threadId = "thread_test_123";
  request._rawBody = {
    prompt_cache_key: threadId,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
    },
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: environmentText }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Inspect the project" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    ],
  };
  return request;
}
