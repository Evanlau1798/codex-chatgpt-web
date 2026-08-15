import { expect, test } from "bun:test";
import { chatGptCaretAtLogicalEnd } from "../src/adapters/chatgpt-web/prompt-caret";

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
