import { ChatGptPromptInsertionMetrics, type ChatGptPromptInsertionSnapshot } from "../src/adapters/chatgpt-web/prompt-insertion-metrics";
import { planChatGptPromptInsertion } from "../src/adapters/chatgpt-web/prompt-insertion-plan";
import { expect, test } from "bun:test";
import { chatGptPromptTextEquivalent as equivalent, chatGptPromptMismatchDetails as details,
  chatGptPromptCodePointWindow, readChatGptPromptText } from "../src/adapters/chatgpt-web/prompt-text";
import { chatGptPromptAttachmentMismatch } from "../src/adapters/chatgpt-web/prompt-caret";

for (const [expected, observed, accepted] of [
  ["a  b", "a\u00a0 b", true], ["a  b", "a\u00a0\u00a0b", true],
  ["a b", "a\u00a0b", false], ["a\u00a0 b", "a  b", false],
  ["a\nb", "a\n\nb", false], ["a\n\nb", "a\nb", false], ["abcd", "abdc", false],
  ["abcd", "abc", false], ["a\tb", "a b", false], ["a\r\nb", "a\nb", false],
  ["a\r\nb\u0000😀👩‍💻\u2028x\u2029y", "a\r\nb\u0000😀👩‍💻\u2028x\u2029y", true],
  ["  payload", "payload", false], ["payload\n", "payload", false],
] as const) {
  test(`text contract ${JSON.stringify([expected, observed])}`, () => expect(equivalent(expected, observed)).toBe(accepted));
}

test("only classifies a single LF edit after checking the entire suffix", () => {
  expect(details("a\nbcd", "a\n\nbcd")).toMatchObject({ kind: "single_lf_insertion", deltaUnits: 1 });
  expect(details("a\n\nbcd", "a\nbcd")).toMatchObject({ kind: "single_lf_deletion", deltaUnits: -1 });
  expect(details("a\nbcd", "a\n\nbdc").kind).toBe("other");
  expect(details("x  end", "x\u00a0 \nend")).toMatchObject({ commonPrefixChars: 3, kind: "single_lf_insertion" });
});

test("public mismatch diagnostics never disclose reversible prompt content", () => {
  const error = chatGptPromptAttachmentMismatch("Prompt verification failed", "prefix PRIVATE_BODY", "prefix DIFFERENT_SECRET");
  expect(error.message).not.toContain("PRIVATE");
  expect(error.message).not.toContain("DIFFERENT");
  expect(error.message).not.toContain("CodePoints");
  expect(error.message).not.toContain("U+");
  expect(error.message).toContain("deltaUnits=");
});

test("local code-point window stops at six code points, preserving surrogate behavior", () => {
  expect(chatGptPromptCodePointWindow("", 0)).toBe("");
  expect(chatGptPromptCodePointWindow("😀abcde" + "z".repeat(360_000), 0))
    .toBe("U+1F600,U+0061,U+0062,U+0063,U+0064,U+0065");
  expect(chatGptPromptCodePointWindow("x😀", 2)).toBe("U+DE00");
  expect(chatGptPromptCodePointWindow("abc", 3)).toBe("");
});

test("characterizes existing top-level/LF, decoration and leading-whitespace readback without fixing it", () => {
  const { createDocument } = require("@mixmark-io/domino") as { createDocument(html: string): Document };
  const document = createDocument('<div id="composer"><span data-id="plugin:x" data-keyword="x">PRIVATE_PILL</span><div> A</div><div><br></div><div>B<br>C</div><span data-inline-selection-pill-cursor-target>PRIVATE_CURSOR</span></div>');
  const element = document.getElementById("composer")!;
  expect(readChatGptPromptText(element)).toBe("A\n\nBC");
  expect(element.textContent).toContain("PRIVATE_PILL"); // reader cloned, never mutated the live root
  element.innerHTML = '<span>A</span><span>B</span>';
  expect(readChatGptPromptText(element)).toBe("A\nB"); // known representation, not a new normalization
  expect(equivalent("AB", readChatGptPromptText(element))).toBeFalse();
  element.textContent = "  payload";
  expect(readChatGptPromptText(element)).toBe("payload");
  expect(readChatGptPromptText(element, { preserveLeading: true })).toBe("  payload");
  expect(equivalent("  payload", readChatGptPromptText(element))).toBeFalse();
  element.textContent = "\u2028\u2029\uFEFFpayload";
  expect(readChatGptPromptText(element, { preserveLeading: true })).toBe("\u2028\u2029\uFEFFpayload");
});

test("prompt readback excludes the verified power UI connector pill", () => {
  const { createDocument } = require("@mixmark-io/domino") as { createDocument(html: string): Document };
  const document = createDocument('<div id="composer"><span app-mention-path="app://configured" app-mention-display-name="Codex Native2" contenteditable="false">Native2</span><div>payload</div></div>');
  const element = document.getElementById("composer")!;
  expect(readChatGptPromptText(element)).toBe("payload");
  expect(element.textContent).toContain("Native2");
});


test("verified marker progress is observable but never logged once per marker", () => {
  let now = 0;
  const events: ChatGptPromptInsertionSnapshot[] = [];
  const metrics = new ChatGptPromptInsertionMetrics(planChatGptPromptInsertion("literal"), event => events.push(event), () => now);
  metrics.markers(500);
  metrics.markers(400);
  metrics.markers(300);
  now = 1_000;
  metrics.markers(200);
  expect(events.map(event => [event.event, event.remainingMarkers])).toEqual([["progress", 400], ["progress", 200]]);
  metrics.finish();
  metrics.markers(0);
  expect(events.at(-1)?.remainingMarkers).toBe(200);
});
