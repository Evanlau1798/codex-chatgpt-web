import { namespacedToolName, type CodexTool } from "../../types";
import type { ChatGptTurnEnvironment } from "./environment";

export function exactTool(environment: ChatGptTurnEnvironment, name: string): CodexTool | undefined {
  return environment.tools.find(tool => !tool.namespace && tool.name === name);
}

export function execGateway(environment: ChatGptTurnEnvironment): CodexTool | undefined {
  const tool = exactTool(environment, "exec");
  return tool?.freeform ? tool : undefined;
}

export const CHATGPT_WEB_AGENT_WAIT_POLL_MS = 30_000;
export const CHATGPT_WEB_SYNC_WAIT_RULE = "Use timeout_ms=30000 for wait_agent. A timeout means pending; repeat the same target ids until a native terminal result is returned.";
export const CHATGPT_WEB_AGENT_WAIT_RULE = "Native2 wait_agent: use structured codex_tool_call with timeout_ms=30000. It returns an asynchronous wait_id, not an agent status. Retrieve that same operation with codex_tool_inventory query=next_query and the same turn_token until operation_status=ready; inspect result for the original native outcome. Do not start another wait while a receipt is pending, busy-poll, or submit final before retrieving the result. A native timeout means pending, not failed or completed; only then start the next wait for the same target ids if needed. Do not embed wait_agent in raw exec.";
export const CONNECTOR_LONG_POLL_SLICE_MS = 30_000;

const wireName = (tool: CodexTool): string => namespacedToolName(tool.namespace, tool.name);
const isAgentWaitTool = (tool: CodexTool): boolean => tool.name === "wait_agent"
  && (tool.namespace === "multi_agent_v1" || tool.namespace === "multi_agent_v2"
    || tool.namespace === "collaboration");

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

export function browserToolDescription(tool: CodexTool, native = true): string {
  const waitRule = native ? CHATGPT_WEB_AGENT_WAIT_RULE : CHATGPT_WEB_SYNC_WAIT_RULE;
  if (isAgentWaitTool(tool)) return `${tool.description}\n\n${waitRule}`;
  if (!tool.namespace && tool.name === "exec") {
    return `${tool.description}\n\n${waitRule} Recursive raw exec is unavailable.`;
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
  const { default: _ignoredDefault, ...timeoutSchema } = timeout;
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((value): value is string => typeof value === "string") : [];
  return {
    ...parameters,
    properties: {
      ...properties,
      timeout_ms: {
        ...timeoutSchema, type: "number", const: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        minimum: CHATGPT_WEB_AGENT_WAIT_POLL_MS, maximum: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        description: "Required transport-safe polling interval. Use exactly 30000; timeout means pending, so repeat the same targets until completion.",
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

export function boundedConnectorToolArguments(tool: CodexTool | string, args: Record<string, unknown>): Record<string, unknown> {
  const name = typeof tool === "string" ? tool : wireName(tool);
  if (!["wait", "write_stdin", "multi_agent_v1__wait_agent", "collaboration__wait_agent"].includes(name)) return args;
  const key = typeof args.timeout_ms === "number" ? "timeout_ms"
    : typeof args.yield_time_ms === "number" ? "yield_time_ms" : undefined;
  return !key || (args[key] as number) <= CONNECTOR_LONG_POLL_SLICE_MS
    ? args : { ...args, [key]: CONNECTOR_LONG_POLL_SLICE_MS };
}
