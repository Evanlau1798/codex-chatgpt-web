import { describe, expect, test } from "bun:test";
import { matchingToolInventory, matchesToolInventoryQuery } from "../src/adapters/chatgpt-web/mcp-server";

const glob = "Glob\nGlob\n\nFind files by pattern";
const read = "Read\nRead\n\nRead a file";

describe("Native2 tool inventory query", () => {
  test("matches any requested capability instead of treating the query as one phrase", () => {
    expect(matchesToolInventoryQuery(glob, "Glob Read Agent")).toBe(true);
    expect(matchesToolInventoryQuery(read, "Glob, Read, Agent")).toBe(true);
    expect(matchesToolInventoryQuery(glob, "Edit Write")).toBe(false);
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
