import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { namespacedToolName, type CodexTool } from "../../types";
import type { ChatGptTurnEnvironment } from "./environment";
import { CODEX_COMPACTION_CONTROL_WIRE_NAME } from "./native-compaction-control";
import { requestScopeSummary, type McpRequestExtra } from "./mcp-request-diagnostics";
import { callTurnBroker } from "./turn-broker";

export type ChatGptMcpContract = "native" | "safe";

const BRIDGE_TOOL_NAMES = new Set([
  "codex_turn_start",
  "codex_exec",
  "codex_write_stdin",
  "codex_apply_patch",
  "codex_view_image",
  "codex_tool_inventory",
  "codex_tool_call",
  "codex_turn_complete",
]);

export const ZERO_RISK_MCP_INSTRUCTIONS = [
  "For each pasted Codex Web GPT request, begin with codex_turn_start using the request_id in its request block.",
  "Use that request_id with the Codex tools needed for the task.",
  "When the task is finished, send the complete answer with codex_turn_complete.",
  "If a tool returns an error, report that error instead of changing the request_id.",
].join(" ");

export function turnReferenceInput(
  contract: ChatGptMcpContract,
  schema: z.ZodString,
): Record<string, z.ZodString> {
  return contract === "safe" ? { request_id: schema } : { turn_token: schema };
}

export function turnReference(contract: ChatGptMcpContract, input: object): string {
  const key = contract === "safe" ? "request_id" : "turn_token";
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== "string") throw new Error(`${key} is required`);
  return value;
}

export function afterSafeStart(contract: ChatGptMcpContract, description: string): string {
  return contract === "safe"
    ? `For a Zero Risk request connected by codex_turn_start. ${description}`
    : description;
}

export function safeVisibleTools(
  environment: ChatGptTurnEnvironment,
  contract: ChatGptMcpContract,
): CodexTool[] {
  if (contract === "native") return environment.tools;
  const bridgeNamespaces = new Set(environment.tools
    .filter(tool => tool.namespace && BRIDGE_TOOL_NAMES.has(tool.name))
    .map(tool => tool.namespace!));
  return environment.tools.filter(tool => (
    namespacedToolName(tool.namespace, tool.name) !== CODEX_COMPACTION_CONTROL_WIRE_NAME
    && !BRIDGE_TOOL_NAMES.has(tool.name)
    && (tool.namespace !== undefined || tool.name !== "exec")
    && (!tool.namespace || !bridgeNamespaces.has(tool.namespace))
  ));
}

function result(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

export function registerZeroRiskLifecycleTools(server: McpServer, brokerSocketPath: string): void {
  const tokenSchema = z.string().min(20).max(256);
  server.registerTool("codex_turn_start", {
    title: "Connect a Codex Zero Risk request",
    description: "Connect the request_id included in the pasted Codex Web GPT request so its Codex tools can be used.",
    inputSchema: { request_id: tokenSchema },
    outputSchema: { started: z.literal(true), duplicate: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ request_id }, extra: McpRequestExtra) => {
    console.error(`[chatgpt-web-mcp] codex_turn_start scope=${requestScopeSummary(extra)}`);
    return result(await callTurnBroker<Record<string, unknown>>(brokerSocketPath, {
      method: "safe_start",
      token: request_id,
    }, null, extra.signal));
  });

  server.registerTool("codex_turn_complete", {
    title: "Return the result to Codex",
    description: "Send the complete answer back to the connected Codex request after its work is finished. For compaction, send the requested compacted summary.",
    inputSchema: {
      request_id: tokenSchema,
      final_answer: z.string().min(1).max(5_000_000),
    },
    outputSchema: { completed: z.literal(true), duplicate: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ request_id, final_answer }, extra: McpRequestExtra) => {
    console.error(`[chatgpt-web-mcp] codex_turn_complete scope=${requestScopeSummary(extra)}`);
    return result(await callTurnBroker<Record<string, unknown>>(brokerSocketPath, {
      method: "safe_complete",
      token: request_id,
      finalAnswer: final_answer,
    }, null, extra.signal));
  });
}
