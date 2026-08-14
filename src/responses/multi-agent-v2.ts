import type { CodexTool } from "../types";

const PLAINTEXT_MESSAGE_TOOLS = new Set(["spawn_agent", "send_message", "followup_task"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function prepareMultiAgentV2Tool(tool: CodexTool): CodexTool {
  if (tool.namespace !== "collaboration" || !PLAINTEXT_MESSAGE_TOOLS.has(tool.name)) return tool;
  const message = record(record(tool.parameters.properties)?.message);
  if (message?.encrypted !== true) return tool;

  const parameters = structuredClone(tool.parameters);
  delete record(record(parameters.properties)?.message)?.encrypted;
  return { ...tool, parameters, plaintextArguments: true };
}
