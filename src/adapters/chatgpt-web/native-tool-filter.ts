import type { CodexTool } from "../../types";

/** A connector cannot safely call its own Codex Native transport through the outer tool inventory. */
export function withoutRecursiveChatGptConnectorTools(tools?: readonly CodexTool[]): CodexTool[] {
  return (tools ?? []).filter(tool => !(
    tool.namespace
    && /(?:^|__)codex_native2?_?$/i.test(tool.namespace)
    && tool.name.startsWith("codex_")
  ));
}
