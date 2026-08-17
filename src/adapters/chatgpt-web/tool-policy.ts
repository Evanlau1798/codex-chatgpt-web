import { namespacedToolName, type CodexParsedRequest, type CodexTool } from "../../types";
import { withoutRecursiveChatGptConnectorTools } from "./native-tool-filter";

export interface EffectiveChatGptToolPolicy {
  tools: CodexTool[];
  wireNames: ReadonlySet<string>;
  requireTool: boolean;
}

export function assertChatGptToolRequirementSatisfied(
  toolPolicy: EffectiveChatGptToolPolicy,
  toolResultDelivered: boolean,
): void {
  if (toolPolicy.requireTool && !toolResultDelivered) {
    throw new Error("ChatGPT tool_choice required at least one request-authorized local tool execution");
  }
}

function policy(tools: CodexTool[], requireTool: boolean): EffectiveChatGptToolPolicy {
  return {
    tools,
    wireNames: new Set(tools.map(tool => namespacedToolName(tool.namespace, tool.name))),
    requireTool,
  };
}

export function effectiveChatGptToolPolicy(parsed: CodexParsedRequest): EffectiveChatGptToolPolicy {
  const available = withoutRecursiveChatGptConnectorTools(parsed.context.tools)
    .filter(tool => tool.loadedFromToolSearch !== true);
  const choice = parsed.options.toolChoice;
  if (choice === "none") return policy([], false);
  if (choice === undefined || choice === "auto") return policy(available, false);
  if (choice === "required") {
    if (available.length === 0) throw new Error("ChatGPT tool_choice required but no request-authorized local tools are available");
    return policy(available, true);
  }

  const selected = "name" in choice
    ? available.filter(tool => namespacedToolName(tool.namespace, tool.name) === choice.name)
    : available.filter(tool => choice.allowedTools.includes(namespacedToolName(tool.namespace, tool.name)));
  const requireTool = "name" in choice || choice.mode === "required";
  if (requireTool && selected.length === 0) {
    throw new Error("ChatGPT tool_choice requires a request-authorized local tool that is unavailable");
  }
  return policy(selected, requireTool);
}
