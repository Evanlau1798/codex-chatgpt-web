import { expect, test } from "bun:test";
import { parseChatGptEffortSliderState } from "../src/chatgpt-session";
import { assertBrowserToolArguments, assertCommandPollArguments, browserToolParameters, browserToolDescription } from "../src/adapters/chatgpt-web/mcp-tool-inventory";
import { assertGatewayToolArguments } from "../src/adapters/chatgpt-web/mcp-gateway";
import { transportBoundRawExecProgram } from "../src/adapters/chatgpt-web/native-command";
import { serializeMultipartContext } from "../src/adapters/chatgpt-web/prompt-multipart";
import { contextTokenBreakdown } from "../src/adapters/chatgpt-web/prompt-token-diagnostics";

test("observed six-position picker is accepted without admitting an invalid range", () => {
  expect(parseChatGptEffortSliderState("1", "6", "4")).toEqual({ min: 1, max: 6, value: 4 });
  expect(parseChatGptEffortSliderState("1", "7", "4")).toBeUndefined();
  expect(parseChatGptEffortSliderState("1", "6", "7")).toBeUndefined();
});

test.each([250, 30_000, 60_000, 60_001, 180_000, 300_000])("transport-safe command poll %s remains valid", value => {
  expect(() => assertCommandPollArguments({ yield_time_ms: value })).not.toThrow();
});

test("internal command inventory advertises the poll ceiling without mutating native schemas", () => {
  const tool = { name: "write_stdin", description: "Poll", parameters: { type: "object", properties: {
    yield_time_ms: { type: "number", maximum: 300_000, default: 180_000 }, session_id: { type: "number" },
  } } };
  const schema = browserToolParameters(tool);
  expect((schema.properties as any).yield_time_ms).toMatchObject({ maximum: 60_000 });
  expect((schema.properties as any).yield_time_ms).not.toHaveProperty("default");
  expect(tool.parameters.properties.yield_time_ms).toMatchObject({ maximum: 300_000, default: 180_000 });
  expect(browserToolDescription(tool)).toContain("60000");
});

test.each([300_001, 1.5, "30000", -1])("oversized or malformed command poll %s fails before execution", value => {
  const tool = { name: "write_stdin", description: "Poll", parameters: {} };
  expect(() => assertBrowserToolArguments(tool, { yield_time_ms: value })).toThrow("300000");
  expect(() => assertGatewayToolArguments("write_stdin", { yield_time_ms: value })).toThrow("300000");
});

test("raw hosted programs reject oversized command polls without calling the native tool", async () => {
  let calls = 0;
  const execute = new Function("tools", "ALL_TOOLS", `return (async () => {${transportBoundRawExecProgram(
    "await tools.write_stdin({session_id: 1, yield_time_ms: 300001});", "exec", true,
  )}})();`);
  await expect(execute({ write_stdin: async () => { calls++; } }, [{ name: "write_stdin" }])).rejects.toThrow("300000");
  expect(calls).toBe(0);
});

test("multipart renderer protection preserves decoded quotes, escapes and literal Markdown", () => {
  const input = { content: '```json\n{"path":"C:\\workspace\\file"}\n```\n[link](https://example.com/a_b) **literal** <tag>\n🙂' };
  const encoded = serializeMultipartContext(input);
  expect(JSON.parse(encoded)).toEqual(input);
  expect(encoded).not.toContain("```");
  expect(encoded).not.toContain("https://");
});

test("submitted-context diagnostics contain only role counts and numerical costs", () => {
  const secret = "PRIVATE_CONTEXT_SENTINEL_DO_NOT_LOG";
  const counts = contextTokenBreakdown([secret], [{ role: "user", content: secret }], true);
  expect(counts.system?.records).toBe(1);
  expect(counts.user?.records).toBe(1);
  expect(counts.user!.tokens).toBeGreaterThan(0);
  expect(JSON.stringify(counts)).not.toContain(secret);
  expect(Object.values(counts).every(group => Object.values(group).every(value => typeof value === "number"))).toBeTrue();
});
