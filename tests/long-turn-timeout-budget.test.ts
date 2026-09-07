import { expect, test } from "bun:test";
import {
  CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS,
} from "../src/adapters/chatgpt-web/browser-worker";
import { MAX_COMPACTION_HANDOFF_TIMEOUT_MS } from "../src/adapters/chatgpt-web/compaction-handoff";
import {
  CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS,
} from "../src/adapters/chatgpt-web/mcp-invocation";

test("No Context Window does not widen the normal native MCP timeout", () => {
  expect(CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS).toBe(90_000);
  expect(CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS).toBeLessThan(CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS);
});

test("No Context Window does not widen the normal structured compaction timeout", () => {
  expect(MAX_COMPACTION_HANDOFF_TIMEOUT_MS).toBe(5 * 60_000);
});
