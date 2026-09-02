import { expect, test } from "bun:test";
import {
  chatGptCaretAtLogicalEnd,
  chatGptPromptAttachmentMismatch,
  clearChatGptComposerInput,
  previousChatGptPromptMarkdownMarker,
} from "../src/adapters/chatgpt-web/prompt-caret";

test("classifies an exact composer readback mismatch as a recoverable pre-submit surface failure", () => {
  const error = chatGptPromptAttachmentMismatch(
    "ChatGPT composer did not commit a complete prompt insertion chunk",
    "abcdef",
    "abcxef",
  );

  expect(error).toMatchObject({
    code: "chatgpt_surface_changed",
    retryable: true,
    retireSession: true,
  });
  expect(error.message).toContain("expectedChars=6");
  expect(error.message).toContain("actualChars=6");
  expect(error.message).toContain("commonPrefixChars=3");
  expect(error.message).toContain("expectedCodePoints=U+0064,U+0065,U+0066");
  expect(error.message).toContain("actualCodePoints=U+0078,U+0065,U+0066");
});

test("reports a caller-supplied equivalent prefix while preserving recoverable surface classification", () => {
  const error = chatGptPromptAttachmentMismatch(
    "ChatGPT composer did not preserve the complete prompt",
    "a  b",
    "a\u00A0 c",
    3,
  );

  expect(error).toMatchObject({
    code: "chatgpt_surface_changed",
    retryable: true,
    retireSession: true,
  });
  expect(error.message).toContain("commonPrefixChars=3");
});

test("accepts a collapsed caret at the logical composer end after Lexical rehomes its DOM node", () => {
  expect(chatGptCaretAtLogicalEnd({
    collapsed: true,
    anchorInsideComposer: true,
    focusInsideComposer: true,
    trailingEditableText: "",
  })).toBeTrue();
});

test("rejects a selection or a caret with remaining editable text", () => {
  expect(chatGptCaretAtLogicalEnd({
    collapsed: false,
    anchorInsideComposer: true,
    focusInsideComposer: true,
    trailingEditableText: "",
  })).toBeFalse();
  expect(chatGptCaretAtLogicalEnd({
    collapsed: true,
    anchorInsideComposer: true,
    focusInsideComposer: true,
    trailingEditableText: "remaining",
  })).toBeFalse();
});

test("rejects a caret that Lexical moved outside the active composer", () => {
  expect(chatGptCaretAtLogicalEnd({
    collapsed: true,
    anchorInsideComposer: false,
    focusInsideComposer: true,
    trailingEditableText: "",
  })).toBeFalse();
});

test("finds Markdown restoration markers strictly right-to-left", () => {
  const replacements = [
    { marker: "\uE000", value: "`", count: 2 },
    { marker: "\uE001", value: "*", count: 2 },
  ];
  const text = "a\uE000b\uE001c\uE000d\uE001";

  expect(previousChatGptPromptMarkdownMarker(text, text.length, replacements)).toEqual({
    offset: 7,
    value: "*",
  });
  expect(previousChatGptPromptMarkdownMarker(text, 7, replacements)).toEqual({
    offset: 5,
    value: "`",
  });
  expect(previousChatGptPromptMarkdownMarker(text, 1, replacements)).toBeUndefined();
});

test("falls back to native selection when Lexical leaves the mention probe after fill", async () => {
  const calls: string[] = [];
  let text = "@codex";
  const composer = {
    fill: async () => { calls.push("fill"); },
    evaluate: async (reader: (element: { textContent: string }) => unknown) => reader({ textContent: text }),
    focus: async () => { calls.push("focus"); },
    press: async (key: string) => {
      calls.push(key);
      if (key === "Backspace") text = "";
    },
  };

  await clearChatGptComposerInput(composer as never);

  expect(text).toBe("");
  expect(calls).toEqual([
    "fill",
    "focus",
    process.platform === "darwin" ? "Meta+A" : "Control+A",
    "Backspace",
  ]);
});

test("does not issue native clearing keys when fill empties the composer", async () => {
  const calls: string[] = [];
  let text = "@codex";
  const composer = {
    fill: async () => { text = ""; calls.push("fill"); },
    evaluate: async (reader: (element: { textContent: string }) => unknown) => reader({ textContent: text }),
    focus: async () => { calls.push("focus"); },
    press: async (key: string) => { calls.push(key); },
  };

  await clearChatGptComposerInput(composer as never);

  expect(calls).toEqual(["fill"]);
});
