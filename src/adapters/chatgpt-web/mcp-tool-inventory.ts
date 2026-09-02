import { namespacedToolName, type CodexTool } from "../../types";

export const CHATGPT_WEB_AGENT_WAIT_POLL_MS = 10_000;
export const CHATGPT_WEB_AGENT_WAIT_RULE = "ChatGPT Web transport rule: wait for exactly 10 seconds per call, then release the MCP channel so spawned Web agents can use their own tools. Repeat with the same target ids until a terminal status is returned.";
const CONNECTOR_LONG_POLL_SLICE_MS = 30_000;

const wireName = (tool: CodexTool): string => namespacedToolName(tool.namespace, tool.name);
const isAgentWaitTool = (tool: CodexTool): boolean => tool.name === "wait_agent"
  && (tool.namespace === "multi_agent_v1" || tool.namespace === "multi_agent_v2");

export function matchingToolInventory(tools: CodexTool[], query?: string): CodexTool[] {
  const terms = query?.trim().toLowerCase().split(/[\s,]+/).filter(Boolean) ?? [];
  return tools.map((tool, index) => {
    const name = wireName(tool).toLowerCase();
    const haystack = [name, tool.name, tool.namespace ?? "", tool.description].join("\n").toLowerCase();
    return {
      tool, index,
      exact: terms.some(term => term === name || term === tool.name.toLowerCase()),
      matches: terms.length === 0 || terms.some(term => haystack.includes(term)),
    };
  }).filter(({ matches }) => matches)
    .sort((left, right) => Number(right.exact) - Number(left.exact) || left.index - right.index)
    .map(({ tool }) => tool);
}

export function browserToolDescription(tool: CodexTool): string {
  if (isAgentWaitTool(tool)) return `${tool.description}\n\n${CHATGPT_WEB_AGENT_WAIT_RULE}`;
  if (!tool.namespace && tool.name === "exec") {
    return `${tool.description}\n\n${CHATGPT_WEB_AGENT_WAIT_RULE} This rule is enforced for wait_agent calls made inside exec; recursive raw exec is unavailable.`;
  }
  return tool.description;
}

export function browserToolParameters(tool: CodexTool): Record<string, unknown> {
  if (!isAgentWaitTool(tool)) return tool.parameters;
  const parameters = structuredClone(tool.parameters);
  const properties = parameters.properties && typeof parameters.properties === "object" && !Array.isArray(parameters.properties)
    ? parameters.properties as Record<string, unknown> : {};
  const timeout = properties.timeout_ms && typeof properties.timeout_ms === "object" && !Array.isArray(properties.timeout_ms)
    ? properties.timeout_ms as Record<string, unknown> : {};
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((value): value is string => typeof value === "string") : [];
  return {
    ...parameters,
    properties: {
      ...properties,
      timeout_ms: {
        ...timeout, type: "number", const: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        minimum: CHATGPT_WEB_AGENT_WAIT_POLL_MS, maximum: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        description: "Required transport-safe polling interval. Use exactly 10000 and repeat the same targets until completion.",
      },
    },
    required: [...new Set([...required, "timeout_ms"])],
  };
}

export function assertBrowserToolArguments(tool: CodexTool, args: Record<string, unknown>): void {
  if (isAgentWaitTool(tool) && args.timeout_ms !== CHATGPT_WEB_AGENT_WAIT_POLL_MS) {
    throw new Error(`ChatGPT Web wait_agent requires timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`
      + " so the shared MCP channel remains available to spawned Web agents");
  }
}

export function boundedConnectorToolArguments(tool: CodexTool, args: Record<string, unknown>): Record<string, unknown> {
  if (!["wait", "multi_agent_v1__wait_agent", "collaboration__wait_agent"].includes(wireName(tool))) return args;
  const key = typeof args.timeout_ms === "number" ? "timeout_ms"
    : typeof args.yield_time_ms === "number" ? "yield_time_ms" : undefined;
  return !key || (args[key] as number) <= CONNECTOR_LONG_POLL_SLICE_MS
    ? args : { ...args, [key]: CONNECTOR_LONG_POLL_SLICE_MS };
}
