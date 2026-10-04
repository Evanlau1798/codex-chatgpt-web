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
  const timeoutFor = (args: Record<string, unknown>, tool: typeof bash): unknown => {
    if (Object.hasOwn(args, "timeout")) return args.timeout;
    const properties = tool?.parameters?.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return undefined;
    const schema = (properties as Record<string, unknown>).timeout;
    return schema && typeof schema === "object" && !Array.isArray(schema)
      ? (schema as Record<string, unknown>).default : undefined;
  };
  for (const request of requests) {
    if (request.freeform || !request.arguments) continue;
    const args = request.arguments;
    const bashTimeout = timeoutFor(args, bash);
    const outputTimeout = timeoutFor(args, output);
    if (request.wireName === "Bash" && supportsBackground && supportsOutputWait
      && typeof bashTimeout === "number" && bashTimeout > CLAUDE_CONNECTOR_WAIT_MS) {
      request.arguments = { ...args, run_in_background: true };
    }
    if (request.wireName === "TaskOutput" && supportsOutputWait
      && typeof outputTimeout === "number" && outputTimeout > CLAUDE_CONNECTOR_WAIT_MS) {
      request.arguments = { ...args, timeout: CLAUDE_CONNECTOR_WAIT_MS };
    }
  }
}
