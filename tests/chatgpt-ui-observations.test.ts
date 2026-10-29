import { expect, test } from "bun:test";
import { CHATGPT_UI_VARIANT_SELECTORS, validateChatGptUiVariantCounts } from "../src/chatgpt-ui/observations";

test("UI diagnostic boundary accepts only known numeric counts and rejects unrelated page data", () => {
  const valid = Object.fromEntries(Object.keys(CHATGPT_UI_VARIANT_SELECTORS)
    .map(name => [name, { attached: 2, rendered: 1 }]));
  expect(validateChatGptUiVariantCounts(valid)).toEqual(valid);
  for (const invalid of [
    undefined, null, [], { url: "https://chatgpt.com/c/private" },
    { ...valid, private: "message" },
    ...[
      { attached: "private", rendered: 1 }, { attached: 41, rendered: 0 },
      { attached: 0, rendered: 1 }, { attached: -1, rendered: 0 },
      { attached: 1.5, rendered: 0 }, { attached: 1, rendered: -1 },
      { attached: 1, rendered: NaN }, { attached: 1, rendered: 0, text: "private" },
    ].flatMap(counts => ["composer.lexical", "modelControl.inlineReasoning"].map(name => ({ ...valid, [name]: counts }))),
  ]) {
    expect(() => validateChatGptUiVariantCounts(invalid)).toThrow("ChatGPT UI variant observation");
  }
});
