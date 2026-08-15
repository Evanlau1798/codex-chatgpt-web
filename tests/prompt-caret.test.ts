import { expect, test } from "bun:test";
import {
  chatGptCaretAtLogicalEnd,
  chatGptPromptAttachmentMismatch,
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
