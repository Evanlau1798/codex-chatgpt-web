import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";

const readTool = { type: "function", name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };

test("hosted web_search from `codex --search` becomes options.webSearch and never a function tool", () => {
  const parsed = parseRequest({
    model: "chatgpt-web/high",
    input: "What changed in the latest release?",
    tools: [{ type: "web_search" }, readTool],
  });

  expect(parsed.options.webSearch).toBe(true);
  expect(parsed.context.tools?.map(tool => tool.name)).toEqual(["read"]);
});

test("the legacy web_search_preview tool type is treated the same way", () => {
  const parsed = parseRequest({
    model: "chatgpt-web/high",
    input: "What changed in the latest release?",
    tools: [{ type: "web_search_preview" }],
  });

  expect(parsed.options.webSearch).toBe(true);
  expect(parsed.context.tools).toBeUndefined();
});

test("web_search riding inside a Responses Lite additional_tools item is detected too", () => {
  const parsed = parseRequest({
    model: "chatgpt-web/luna",
    input: [{ type: "additional_tools", role: "developer", tools: [{ type: "web_search" }, readTool] }],
  });

  expect(parsed.options.webSearch).toBe(true);
  expect(parsed.context.tools?.map(tool => tool.name)).toEqual(["read"]);
});

test("requests without a hosted web_search tool leave options.webSearch unset", () => {
  const parsed = parseRequest({
    model: "chatgpt-web/high",
    input: "Explain the diff",
    tools: [readTool, { type: "image_generation" }],
  });

  expect(parsed.options.webSearch).toBeUndefined();
  expect(parsed.context.tools?.map(tool => tool.name)).toEqual(["read"]);
});
