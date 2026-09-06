import { expect, test } from "bun:test";
import {
  CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS,
} from "../src/adapters/chatgpt-web/browser-worker";
import { MAX_COMPACTION_HANDOFF_TIMEOUT_MS } from "../src/adapters/chatgpt-web/compaction-handoff";
import { CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS } from "../src/adapters/chatgpt-web/mcp-invocation";
import { CHATGPT_COMPACTION_PROMPT_ATTACHMENT_TIMEOUT_MS } from "../src/adapters/chatgpt-web/prompt-attachment-budget";

test("native MCP waits cover the longest supported poll with cleanup headroom", () => {
  expect(CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS).toBe(6 * 60_000);
  expect(CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS).toBeLessThan(CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS);
});

test("structured compaction allows an extended Pro reasoning pass", () => {
  expect(MAX_COMPACTION_HANDOFF_TIMEOUT_MS).toBe(15 * 60_000);
  expect(CHATGPT_COMPACTION_PROMPT_ATTACHMENT_TIMEOUT_MS).toBe(MAX_COMPACTION_HANDOFF_TIMEOUT_MS);
});
