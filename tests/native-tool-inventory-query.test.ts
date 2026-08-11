import { describe, expect, test } from "bun:test";
import { matchesToolInventoryQuery } from "../src/adapters/chatgpt-web/mcp-server";

const glob = "Glob\nGlob\n\nFind files by pattern";
const read = "Read\nRead\n\nRead a file";

describe("Native2 tool inventory query", () => {
  test("matches any requested capability instead of treating the query as one phrase", () => {
    expect(matchesToolInventoryQuery(glob, "Glob Read Agent")).toBe(true);
    expect(matchesToolInventoryQuery(read, "Glob, Read, Agent")).toBe(true);
    expect(matchesToolInventoryQuery(glob, "Edit Write")).toBe(false);
  });
});
