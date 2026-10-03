import { expect, test } from "bun:test";
import {
  CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS,
} from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptCompactionDeadlineMs } from "../src/adapters/chatgpt-web/compaction-handoff";
import {
  CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS,
} from "../src/adapters/chatgpt-web/mcp-invocation";

test("No Context Window does not widen the normal native MCP timeout", () => {
  expect(CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS).toBe(90_000);
  expect(CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS).toBeLessThan(CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS);
});

test("Pro compaction has no implicit deadline and honors explicit budgets without a five-minute cap", () => {
  expect(chatGptCompactionDeadlineMs()).toBeNull();
  expect(chatGptCompactionDeadlineMs(null)).toBeNull();
  expect(chatGptCompactionDeadlineMs(20)).toBe(20);
  expect(chatGptCompactionDeadlineMs(600_000)).toBe(600_000);
  expect(() => chatGptCompactionDeadlineMs(0)).toThrow();
});
