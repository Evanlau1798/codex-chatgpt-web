import { expect, test } from "bun:test";
import { estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { CHATGPT_WEB_LUNA_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { chatGptUsageInputForRound, estimateChatGptWebInputTokens, estimateChatGptWebUsage } from "../src/adapters/chatgpt-web/usage";
import type { CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };

function request(text: string): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: false,
    context: { messages: [{ role: "user", content: text, timestamp: 1 }] },
    options: { reasoning: "high" },
  };
}

test.each([
  ["highly compressible", "a".repeat(480_000)],
  ["ordinary repeated words", `${"word ".repeat(79_999)}word`],
])("%s context uses tokenizer-derived usage without character-pressure inflation", (_label, text) => {
  expect(estimateChatGptWebInputTokens(request(text), capabilities)).toBeLessThan(100_000);
}, 15_000);

test("ordinary tool rounds report the latest Codex context while Luna keeps its bounded checkpoint", () => {
  const prepared = request("initial request");
  const latest = request("initial request plus a large tool result ".repeat(2_000));

  expect(chatGptUsageInputForRound(latest, prepared)).toBe(latest);
  expect(chatGptUsageInputForRound({ ...latest, modelId: CHATGPT_WEB_LUNA_MODEL_ID }, prepared)).toBe(prepared);
});

test("usage includes the Native2 and enhanced output tunnel contracts actually sent", () => {
  const parsed = request("Inspect the repository.");
  parsed.context.systemPrompt = ["Follow the task instructions."];
  parsed.context.tools = [{ name: "Read", description: "Read a file", parameters: {} }];
  const toolCapabilities = { ...capabilities, localToolsEnabled: true };
  const token = "turn_12345678901234567890123456789012";
  const actual = compileChatGptWebPrompt(parsed, toolCapabilities, token, {
    nativeControlConnector: true,
    useEnhancedOutputTunnel: true,
  });
  const usage = estimateChatGptWebUsage(
    parsed,
    {},
    toolCapabilities,
    false,
    { nativeControlConnector: true, useEnhancedOutputTunnel: true },
  );

  expect(usage.inputTokens).toBe(estimateCompiledChatGptWebInputTokens(actual, parsed.modelId, [token]));
});
