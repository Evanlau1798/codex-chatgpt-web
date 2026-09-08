import { expect, test } from "bun:test";
import { insertChatGptComposerPlainText } from "../src/adapters/chatgpt-web/prompt-caret";
import {
  STRUCTURED_MARKDOWN_RESTORATION_PROBE_CHARS,
  structuredMarkdownRestorationProbeText,
} from "../scripts/lifecycle-smoke/markdown-restoration-probe";

test("restores a structured Native2 prompt with exact single-marker edits", async () => {
  const { createDocument } = require("@mixmark-io/domino") as {
    createDocument: (html: string) => Document;
  };
  const prompt = structuredMarkdownRestorationProbeText();
  expect(prompt).toHaveLength(STRUCTURED_MARKDOWN_RESTORATION_PROBE_CHARS);
  expect(prompt).toContain("```json\n");
  expect(prompt).toContain("<environment_context>\n");

  const document = createDocument('<div id="composer"></div>') as Document & {
    createRange: () => Range;
    execCommand: (command: string, showUi: boolean, value: string) => boolean;
  };
  let composerElement = document.getElementById("composer")!;
  let text = document.createTextNode("");
  composerElement.appendChild(text);
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => composerElement });
  let selected = { start: 0, end: 0 };
  let longestRestoration = 0;
  let restorationEdits = 0;
  const restorationOffsets: number[] = [];
  const batchSizes: number[] = [];
  let zeroDelayYields = 0;
  const originalSetTimeout = globalThis.setTimeout;
  document.createRange = () => {
    let start = 0;
    let end = 0;
    return {
      setStart: (_node: Node, offset: number) => { start = offset; },
      setEnd: (_node: Node, offset: number) => { end = offset; },
      get startOffset() { return start; },
      get endOffset() { return end; },
    } as unknown as Range;
  };
  document.execCommand = (command, _showUi, value) => {
    if (command !== "insertText" || typeof value !== "string") return false;
    const replacedChars = selected.end - selected.start;
    let inserted = value;
    if (replacedChars > 0) {
      restorationEdits += 1;
      restorationOffsets.push(selected.start);
      longestRestoration = Math.max(longestRestoration, replacedChars);
      // Lexical may rewrite a multi-marker range even though execCommand reports success.
      if (replacedChars > 1) inserted = value.slice(1);
    }
    text.data = `${text.data.slice(0, selected.start)}${inserted}${text.data.slice(selected.end)}`;
    selected = { start: selected.start + inserted.length, end: selected.start + inserted.length };
    return true;
  };

  const previous = {
    document: globalThis.document,
    NodeFilter: globalThis.NodeFilter,
    window: globalThis.window,
  };
  Object.assign(globalThis, {
    document,
    NodeFilter: { SHOW_TEXT: 4 },
    window: {
      getSelection: () => ({
        get isCollapsed() { return selected.start === selected.end; },
        get anchorNode() { return text; },
        get focusNode() { return text; },
        removeAllRanges: () => {},
        addRange: (range: Range) => { selected = { start: range.startOffset, end: range.endOffset }; },
      }),
    },
  });
  const composer = {
    focus: async () => {},
    evaluate: async (callback: (element: HTMLElement, input: unknown) => unknown, input: unknown) => {
      const editsBefore = restorationEdits;
      const result = await callback(composerElement, input);
      if (typeof input === "object" && input !== null && !Array.isArray(input)) {
        batchSizes.push(restorationEdits - editsBefore);
        const replacement = document.createElement("div");
        text = document.createTextNode(text.data);
        replacement.appendChild(text);
        composerElement.parentNode?.replaceChild(replacement, composerElement);
        composerElement = replacement;
      }
      return result;
    },
  };

  try {
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 0) zeroDelayYields += 1;
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout;
    await insertChatGptComposerPlainText(composer as never, prompt);
    expect(text.data).toBe(prompt);
    expect(restorationEdits).toBeGreaterThan(128);
    expect(longestRestoration).toBe(1);
    expect(restorationOffsets.every((offset, index) => index === 0 || offset < restorationOffsets[index - 1]!))
      .toBeTrue();
    expect(batchSizes.length).toBeGreaterThan(1);
    expect(batchSizes.every(size => size > 0 && size <= 128)).toBeTrue();
    expect(zeroDelayYields).toBeGreaterThanOrEqual(batchSizes.length);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    Object.assign(globalThis, previous);
  }
});
