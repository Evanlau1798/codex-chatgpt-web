import { expect, test } from "bun:test";
import {
  compiledChatGptWebMessages,
  estimateChatGptWebImageTokens,
  estimateCompiledChatGptWebInputTokens,
} from "../src/adapters/chatgpt-web/input-tokens";
import {
  assertChatGptWebMultipartInputWithinLimits,
  resolveChatGptWebMultipartStagingMode,
} from "../src/adapters/chatgpt-web/multipart-browser-transport";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { resolveBiggerContextMultipartParts } from "../src/adapters/chatgpt-web/usage";
import { estimateTokens } from "../src/lib/token-estimate";
import type { CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: false, solAvailable: true, proAvailable: true };
const request = (messages: string[]): CodexParsedRequest => ({
  modelId: "gpt-5.6-sol",
  stream: true,
  context: { messages: messages.map((content, index) => ({ role: "user", content, timestamp: index + 1 })) },
  options: { reasoning: "high" },
});

test("multipart selection accounts for whole-record and composer fit", () => {
  const plus = { ...capabilities, proAvailable: false };
  for (const [contents, expected] of [
    [["small task"], undefined],
    [[50_000, 40_000, 50_000, 5_000].map(n => "word ".repeat(n)), 3],
    [Array.from({ length: 3 }, () => " ".repeat(450_000)), 2],
  ] as const) {
    const parsed = request([...contents]);
    const parts = resolveBiggerContextMultipartParts(parsed, plus);
    expect(parts).toBe(expected);
    const compiled = compileChatGptWebPrompt(parsed, plus, undefined, { experimentalMultipartParts: parts });
    if (parts) {
      expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records)
        .map(record => record.message.content)).toEqual([...contents]);
    }
  }
}, 60_000);

test("Bigger Context compaction selects three parts before the inline byte budget", () => {
  const parsed = request(["x".repeat(160_000)]);
  parsed._compactionRequest = true;
  const parts = resolveBiggerContextMultipartParts(parsed, capabilities);
  expect(parts).toBe(3);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, undefined, { experimentalMultipartParts: parts });
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records)
    .map(record => record.message.content)).toEqual([parsed.context.messages[0]!.content]);
});

test("multipart planning reserves the final message for attachments and execution instructions", () => {
  const parsed = request(Array.from({ length: 36 }, (_, index) => `record ${index}: ${"word ".repeat(5_000)}`));
  parsed.context.messages.push({
    role: "user",
    content: Array.from({ length: 3 }, (_, index) => ({
      type: "image" as const,
      imageUrl: `data:image/png;base64,partition-image-${index}`,
      detail: "original" as const,
    })),
    timestamp: 37,
  });
  const compiled = compileChatGptWebPrompt(parsed, capabilities, undefined, { experimentalMultipartParts: 3 });
  const messages = compiledChatGptWebMessages(compiled);
  const tokens = messages.map(text => estimateTokens(text));
  const chars = messages.map(text => text.length);
  const stage = resolveChatGptWebMultipartStagingMode(
    parsed.modelId, capabilities, Math.max(...tokens.slice(0, -1)), Math.max(...chars.slice(0, -1)),
  );
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId),
    Math.max(...tokens),
    parsed.modelId,
    "high",
    capabilities,
    Math.max(...chars),
    3,
    {
      stagingEffort: stage.effort,
      maxStageMessageTokens: Math.max(...tokens.slice(0, -1)),
      maxStageChars: Math.max(...chars.slice(0, -1)),
      finalMessageTokens: tokens.at(-1)!,
      finalMessageChars: chars.at(-1)!,
      finalImageTokens: estimateChatGptWebImageTokens(compiled),
    },
  )).not.toThrow();
}, 30_000);
