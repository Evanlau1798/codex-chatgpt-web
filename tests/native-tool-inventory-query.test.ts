import { describe, expect, test } from "bun:test";
import { matchingToolInventory } from "../src/adapters/chatgpt-web/mcp-server";

const tool = (name: string, description: string) => ({ name, description, parameters: {} });

describe("Native2 tool inventory query", () => {
  test("matches any requested capability instead of treating the query as one phrase", () => {
    expect(matchingToolInventory([tool("Glob", "Find files by pattern")], "Glob Read Agent")).toHaveLength(1);
    expect(matchingToolInventory([tool("Read", "Read a file")], "Glob, Read, Agent")).toHaveLength(1);
    expect(matchingToolInventory([tool("Glob", "Find files by pattern")], "Edit Write")).toHaveLength(0);
  });

  test("keeps exact wire and tool names ahead of broad description matches", () => {
    const decoys = Array.from({ length: 25 }, (_, index) => ({
      name: `decoy_${index}`,
      description: "Read a file for diagnostics",
      parameters: {},
    }));
    const exact = { name: "Read", description: "Load repository content", parameters: {} };

    expect(matchingToolInventory([...decoys, exact], "Read File Agent").slice(0, 20)).toContain(exact);
    expect(matchingToolInventory([...decoys, exact], "Read File Agent")[0]).toBe(exact);
  });
});
