import type { CodexParsedRequest } from "../../types";
import type { BrokerToolRequest } from "./turn-broker";

// This bounds an MCP response wait, not the command's lifetime. Native Claude
// owns the background task and its original timeout, cancellation and output.
export const CLAUDE_CONNECTOR_WAIT_MS = 30_000;

export function normalizeClaudeLongCommands(parsed: CodexParsedRequest, requests: BrokerToolRequest[]): void {
  const tools = parsed.context.tools ?? [];
  const bash = tools.find(tool => !tool.namespace && tool.name === "Bash");
  const output = tools.find(tool => !tool.namespace && tool.name === "TaskOutput");
  const supportsBackground = bash?.parameters?.properties &&
    Object.hasOwn(bash.parameters.properties, "run_in_background");
  const supportsOutputWait = output?.parameters?.properties &&
    Object.hasOwn(output.parameters.properties, "timeout");
  if (!supportsBackground || !supportsOutputWait) return;
  for (const request of requests) {
    if (request.freeform || !request.arguments) continue;
    const args = request.arguments;
    if (request.wireName === "Bash" && typeof args.timeout === "number" && args.timeout > CLAUDE_CONNECTOR_WAIT_MS) {
      request.arguments = { ...args, run_in_background: true };
    }
    if (request.wireName === "TaskOutput" && typeof args.timeout === "number" && args.timeout > CLAUDE_CONNECTOR_WAIT_MS) {
      request.arguments = { ...args, timeout: CLAUDE_CONNECTOR_WAIT_MS };
    }
  }
}
