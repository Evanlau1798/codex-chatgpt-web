import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CHATGPT_PROMPT_INSERT_CHUNK_CHARS,
  chatGptNoContextStallTimeoutMs,
  chatGptPromptAttachmentTimeoutMs,
} from "../src/adapters/chatgpt-web/prompt-attachment-budget";
import { resolveBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { defaultConfig } from "../src/config";
import { providerConfig } from "../src/provider-config";

test("no-auto-compact scales prompt attachment time with composer chunks", () => {
  expect(chatGptPromptAttachmentTimeoutMs(CHATGPT_PROMPT_INSERT_CHUNK_CHARS, false)).toBe(60_000);
  expect(chatGptPromptAttachmentTimeoutMs(CHATGPT_PROMPT_INSERT_CHUNK_CHARS * 2, true)).toBe(60_000);
  expect(chatGptPromptAttachmentTimeoutMs(CHATGPT_PROMPT_INSERT_CHUNK_CHARS * 10, true)).toBe(300_000);
  expect(chatGptPromptAttachmentTimeoutMs(CHATGPT_PROMPT_INSERT_CHUNK_CHARS * 6, true)).toBe(180_000);
});

test("no-auto-compact keeps the stall watchdog finite while scaling with prompt work", () => {
  expect(chatGptNoContextStallTimeoutMs(CHATGPT_PROMPT_INSERT_CHUNK_CHARS)).toBe(360_000);
  expect(chatGptNoContextStallTimeoutMs(CHATGPT_PROMPT_INSERT_CHUNK_CHARS * 10)).toBe(600_000);
  expect(chatGptNoContextStallTimeoutMs(CHATGPT_PROMPT_INSERT_CHUNK_CHARS, 900)).toBe(900_000);
  expect(chatGptNoContextStallTimeoutMs(CHATGPT_PROMPT_INSERT_CHUNK_CHARS * 1_000)).toBe(3_600_000);
  expect(chatGptNoContextStallTimeoutMs(CHATGPT_PROMPT_INSERT_CHUNK_CHARS * 10, undefined, 450_000)).toBe(450_000);
});

test("the experimental setting reaches both browser attachment stages", () => {
  const config = defaultConfig("full");
  config.experimentalNoAutoCompact = true;
  const provider = providerConfig(config);

  expect(provider.chatgptWeb?.experimentalNoAutoCompact).toBe(true);
  expect(resolveBrowserConfig(provider).experimentalNoAutoCompact).toBe(true);

  const source = readFileSync("src/adapters/chatgpt-web/browser-worker.ts", "utf8");
  expect(source).toContain(
    "chatGptPromptAttachmentTimeoutMs(stage.text.length, this.config.experimentalNoAutoCompact)",
  );
  expect(source).toContain(
    "chatGptPromptAttachmentTimeoutMs(responsePrompt.length, this.config.experimentalNoAutoCompact)",
  );
});
