import { describe, expect, test } from "bun:test";
import { ChatGptMarkdownBuffer } from "../src/adapters/chatgpt-web/markdown";

describe("ChatGPT Markdown DOM reconciliation", () => {
  test("keeps an append-only answer when completion merges equivalent visible blocks", () => {
    const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
    const split = [
      { key: "0:p", html: "<p>First paragraph.</p>", text: "First paragraph.", streamable: true },
      { key: "1:p", html: "<p>Second paragraph.</p>", text: "Second paragraph.", streamable: false },
    ];

    expect(buffer.observe(split, 0)).toBe("First paragraph.");
    expect(buffer.observe([{
      key: "0:root",
      html: "<p>First paragraph.</p><p>Second paragraph.</p>",
      text: "First paragraph.\n\nSecond paragraph.",
      streamable: false,
    }], 1)).toBe("");
    expect(buffer.finish()).toEqual({
      markdown: "First paragraph.\n\nSecond paragraph.",
      delta: "\n\nSecond paragraph.",
    });
  });

  test("still rejects a regrouping that removes streamed visible text", () => {
    const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
    buffer.observe([
      { key: "0:p", html: "<p>Required evidence.</p>", text: "Required evidence.", streamable: true },
      { key: "1:p", html: "<p>Final answer.</p>", text: "Final answer.", streamable: false },
    ], 0);

    expect(() => buffer.observe([{
      key: "0:p",
      html: "<p>Final answer.</p>",
      text: "Final answer.",
      streamable: false,
    }], 1)).toThrow("completed text block");
  });
});
