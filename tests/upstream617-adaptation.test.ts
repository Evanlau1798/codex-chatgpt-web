import { expect, test } from "bun:test";
import { chatGptModelFamilyMatches } from "../src/adapters/chatgpt-web/model-selection";
import { CHATGPT_WEB_LUNA_BACKEND_MODEL, resolveChatGptWebContextLimits } from "../src/chatgpt-web-models";

test("GPT-6 Sol reasoning accepts localized punctuation without accepting Astra reasoning", () => {
  expect(chatGptModelFamilyMatches(["GPT-6 Sol Extra High，4 of 5。"], "6", "xhigh")).toBeTrue();
  expect(chatGptModelFamilyMatches(["GPT-6 Astra Extra High，4 of 5。"], "6", "xhigh")).toBeFalse();
  expect(chatGptModelFamilyMatches(["GPT-6 Astra Pro，5 of 5。"], "6", "max")).toBeTrue();
});

test("Original Luna staged context stays bounded independently of the underlying model window", () => {
  const limits = resolveChatGptWebContextLimits(CHATGPT_WEB_LUNA_BACKEND_MODEL, "medium", {
    solAvailable: false, proAvailable: false, experimentalBiggerContext: true,
  });
  expect(limits.contextWindow).toBe(84_000);
  expect(limits.autoCompactTokenLimit).toBe(59_424);
});
