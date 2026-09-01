import { CHATGPT_WEB_AGENT_WAIT_POLL_MS, CHATGPT_WEB_AGENT_WAIT_RULE } from "./mcp-tool-inventory";

export const GATEWAY_AGENT_WAIT_TOOL_NAMES = [
  "multi_agent_v1__wait_agent",
  "multi_agent_v2__wait_agent",
] as const;
const AGENT_WAIT_TOOLS = new Set<string>(GATEWAY_AGENT_WAIT_TOOL_NAMES);

export interface GatewayToolDescriptor { name: string; description: string }
export interface GatewayToolCatalogPage { tools: GatewayToolDescriptor[]; total: number }

export function gatewayToolNameIsValid(name: string): boolean {
  return /^[A-Za-z0-9_$]+$/.test(name);
}

export function isGatewayAgentWaitTool(name: string): boolean {
  return AGENT_WAIT_TOOLS.has(name);
}

export function gatewayToolDescription(tool: GatewayToolDescriptor): string {
  return isGatewayAgentWaitTool(tool.name) ? `${tool.description}\n\n${CHATGPT_WEB_AGENT_WAIT_RULE}` : tool.description;
}

export function assertGatewayToolArguments(name: string, args: Record<string, unknown>): void {
  if (isGatewayAgentWaitTool(name) && args.timeout_ms !== CHATGPT_WEB_AGENT_WAIT_POLL_MS) {
    throw new Error(`ChatGPT Web wait_agent requires timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`
      + " so the shared MCP channel remains available to spawned Web agents");
  }
}

export function gatewayToolCatalogProgram(options: {
  query?: string;
  offset: number;
  limit: number;
  excludedNames: string[];
}): string {
  const needle = options.query?.trim().toLowerCase() ?? "";
  return [
    "if (typeof ALL_TOOLS === \"undefined\" || !Array.isArray(ALL_TOOLS)) throw new Error(\"Native nested tool registry is unavailable\");",
    `const excludedNames = new Set(${JSON.stringify(options.excludedNames)});`,
    `const needle = ${JSON.stringify(needle)};`,
    "const visible = name => typeof name === \"string\" && /^[A-Za-z0-9_$]+$/.test(name) && !excludedNames.has(name);",
    "const matches = ALL_TOOLS.filter(tool => visible(tool?.name))",
    "  .map(tool => ({ name: tool.name, description: typeof tool.description === \"string\" ? tool.description : \"\" }))",
    "  .filter(tool => !needle || (tool.name + \"\\n\" + tool.description).toLowerCase().includes(needle));",
    `text(JSON.stringify({ tools: matches.slice(${options.offset}, ${options.offset + options.limit}), total: matches.length }));`,
  ].join("\n");
}

export function gatewayToolCatalogPage(
  response: { content: unknown[]; isError?: boolean },
  excludedNames: ReadonlySet<string>,
): GatewayToolCatalogPage {
  const text = response.content.flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const block = item as Record<string, unknown>;
    return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
  });
  if (response.isError) throw new Error(`Native nested tool inventory failed: ${text.join("\n") || "unknown error"}`);
  if (text.length !== 1) throw new Error("Native nested tool inventory returned an invalid text response");
  let parsed: unknown;
  try { parsed = JSON.parse(text[0]!); }
  catch { throw new Error("Native nested tool inventory returned invalid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Native nested tool inventory returned an invalid catalog");
  }
  const catalog = parsed as Record<string, unknown>;
  if (!Number.isSafeInteger(catalog.total) || (catalog.total as number) < 0 || !Array.isArray(catalog.tools)) {
    throw new Error("Native nested tool inventory returned invalid pagination");
  }
  const tools = catalog.tools.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Native nested tool inventory returned an invalid tool entry");
    }
    const tool = value as Record<string, unknown>;
    if (typeof tool.name !== "string" || typeof tool.description !== "string"
      || !gatewayToolNameIsValid(tool.name) || excludedNames.has(tool.name)) {
      throw new Error("Native nested tool inventory returned an invalid tool descriptor");
    }
    return { name: tool.name, description: tool.description };
  });
  return { tools, total: catalog.total as number };
}
