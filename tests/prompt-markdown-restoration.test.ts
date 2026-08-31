import { expect, test } from "bun:test";
import {
  guardChatGptPromptMarkdown,
  planChatGptPromptMarkdownRestoration,
} from "../src/adapters/chatgpt-web/prompt-caret";

test("plans incident-sized Markdown restoration in bounded text ranges", () => {
  const pattern = "field_name=value) [literal](target) `code` *bold* ~=~ ";
  const prompt = pattern.repeat(Math.ceil(93_255 / pattern.length)).slice(0, 93_255);
  const guarded = guardChatGptPromptMarkdown(prompt);

  expect(guarded).toBeDefined();
  expect(guarded!.count).toBeGreaterThan(2_484);
  const ranges = planChatGptPromptMarkdownRestoration(
    guarded!.text,
    guarded!.replacements,
    16_000,
  );

  expect(ranges.length).toBeLessThanOrEqual(Math.ceil(prompt.length / 16_000) + 1);
  expect(ranges.every(range => range.end - range.start <= 16_000)).toBeTrue();
  expect(ranges.reduce((count, range) => count + range.count, 0)).toBe(guarded!.count);
  expect(ranges.every((range, index) => index === 0 || range.end <= ranges[index - 1]!.start)).toBeTrue();
});

test("restoration planning ignores unguarded text and rejects invalid bounds", () => {
  expect(planChatGptPromptMarkdownRestoration("plain text", [], 16_000)).toEqual([]);
  expect(() => planChatGptPromptMarkdownRestoration("\uE000", [
    { marker: "\uE000", value: "*", count: 1 },
  ], 0)).toThrow("positive");
});

test("restoration ranges carry trailing whitespace with one following code unit", () => {
  expect(planChatGptPromptMarkdownRestoration(
    "a\uE000 word",
    [{ marker: "\uE000", value: "*", count: 1 }],
    8,
  )).toEqual([{ start: 1, end: 4, count: 1 }]);
});
