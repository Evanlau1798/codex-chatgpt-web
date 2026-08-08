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

test("large inline prompts use tokenizer-derived usage without invented composer pressure", () => {
  const estimated = estimateChatGptWebInputTokens(request("a".repeat(480_000)), capabilities);

  expect(estimated).toBeLessThan(100_000);
});

test("ordinary context below the transport threshold keeps its tokenizer-derived usage", () => {
  const estimated = estimateChatGptWebInputTokens(
    request(`${"word ".repeat(79_999)}word`),
    capabilities,
  );

  expect(estimated).toBeLessThan(100_000);
});

test("ordinary tool rounds report the latest Codex context while Luna keeps its bounded checkpoint", () => {
  const prepared = request("initial request");
  const latest = request("initial request plus a large tool result ".repeat(2_000));

  expect(chatGptUsageInputForRound(latest, prepared)).toBe(latest);
  expect(chatGptUsageInputForRound({ ...latest, modelId: CHATGPT_WEB_LUNA_MODEL_ID }, prepared)).toBe(prepared);
});
