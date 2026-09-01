import { expect, test } from "bun:test";
import { CHATGPT_WEB_LUNA_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { chatGptUsageInputForRound, estimateChatGptWebInputTokens } from "../src/adapters/chatgpt-web/usage";
import type { CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: false, solAvailable: true, proAvailable: true };

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
