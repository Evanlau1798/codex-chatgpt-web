import { describe, expect, test } from "bun:test";
import { boundedConnectorToolArguments } from "../src/adapters/chatgpt-web/mcp-server";
import type { CodexTool } from "../src/types";

function tool(namespace: string | undefined, name: string): CodexTool {
  return { namespace, name, description: "", parameters: {} };
}

describe("connector long-poll slicing", () => {
  test("slices V1 and V2 agent waits without changing unrelated tools", () => {
    const args = { timeout_ms: 300_000, marker: "keep" };

    expect(boundedConnectorToolArguments(tool("collaboration", "wait_agent"), args)).toEqual({
      timeout_ms: 30_000,
      marker: "keep",
    });
    expect(boundedConnectorToolArguments(tool(undefined, "multi_agent_v1__wait_agent"), args)).toEqual({
      timeout_ms: 30_000,
      marker: "keep",
    });
    expect(boundedConnectorToolArguments(tool("collaboration", "send_message"), args)).toBe(args);
  });
});
