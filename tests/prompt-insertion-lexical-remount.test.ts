import { expect, test } from "bun:test";
import {
  CHATGPT_PROMPT_INSERT_CHUNK_CHARS,
  ChatGptBrowserWorker,
} from "../src/adapters/chatgpt-web/browser-worker";
import { insertChatGptPromptText } from "../src/adapters/chatgpt-web/prompt-insertion";

test("preserves literal Markdown after Lexical settles before the next chunk", async () => {
  const { createDocument } = require("@mixmark-io/domino") as {
    createDocument: (html: string) => Document;
  };
  const prompt = `${"field *bold* value ".repeat(1_000)}tail`;
  expect(prompt.length).toBeGreaterThan(CHATGPT_PROMPT_INSERT_CHUNK_CHARS);
  const document = createDocument('<div id="composer"></div>') as Document & {
    createRange: () => Range;
    execCommand: (command: string, showUi: boolean, value: string) => boolean;
  };
  const composerElement = document.getElementById("composer")!;
  const text = document.createTextNode("");
  composerElement.appendChild(text);
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => composerElement });

  let selection = { anchorNode: text, focusNode: text, anchorOffset: 0, focusOffset: 0 };
  document.createRange = () => {
    let start = 0;
    let end = 0;
    return {
      setStart: (_node: Node, offset: number) => { start = offset; },
      setEnd: (_node: Node, offset: number) => { end = offset; },
      collapse: () => { end = start; },
      get startOffset() { return start; },
      get endOffset() { return end; },
    } as unknown as Range;
  };
  const selected = { start: 0, end: 0 };
  const selectionApi = {
    get isCollapsed() { return selected.start === selected.end; },
    get anchorNode() { return selection.anchorNode; },
    get focusNode() { return selection.focusNode; },
    removeAllRanges: () => {},
    addRange: (range: Range) => {
      selected.start = range.startOffset;
      selected.end = range.endOffset;
      selection = {
        anchorNode: text,
        focusNode: text,
        anchorOffset: selected.end,
        focusOffset: selected.end,
      };
    },
  };
  document.execCommand = (command, _showUi, value) => {
    if (command !== "insertText" || typeof value !== "string") return false;
    const start = selected.start;
    const end = selected.end;
    text.data = `${text.data.slice(0, start)}${value}${text.data.slice(end)}`;
    selected.start = selected.end = start + value.length;
    selection = {
      anchorNode: text,
      focusNode: text,
      anchorOffset: selected.end,
      focusOffset: selected.end,
    };
    if (start === end && value.includes("*bold* ")) {
      setTimeout(() => { text.data = text.data.replace("*bold*", "bold"); }, 0);
    }
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
    window: { getSelection: () => selectionApi },
  });
  const composer = {
    focus: async () => {},
    evaluate: async (callback: (element: HTMLElement, input: unknown) => unknown, input: unknown) => (
      await callback(composerElement, input)
    ),
  };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    activeComposer: async () => composer,
    attachedPromptText: async () => text.data,
    waitForPromptChunkAttached: async (_page: unknown, expected: string) => {
      await Bun.sleep(0);
      expect(text.data).toBe(expected);
    },
    reanchorPromptCaret: async () => {
      await Bun.sleep(0);
      selected.start = selected.end = text.data.length;
    },
  }) as { insertPromptText(page: unknown, value: string): Promise<void> };

  try {
    await worker.insertPromptText({}, prompt);
    await Bun.sleep(0);
    expect(text.data).toBe(prompt);
  } finally {
    Object.assign(globalThis, previous);
  }
});

test("rejects restored-prefix drift before another irreversible edit", async () => {
  const prompt = `${"a".repeat(CHATGPT_PROMPT_INSERT_CHUNK_CHARS)} tail`;
  let attached = "";
  let contentEdits = 0;
  const composer = {
    focus: async () => {},
    evaluate: async (_callback: unknown, input: unknown) => {
      if (typeof input === "string") {
        if (input.length === 1 && input.charCodeAt(0) >= 0xE000 && input.charCodeAt(0) <= 0xF8FF) {
          return !attached.includes(input);
        }
        contentEdits += 1;
        attached += input;
        return true;
      }
      const replacement = input as { marker: string; value: string };
      attached = `x${attached.slice(1).replace(replacement.marker, replacement.value)}`;
      return true;
    },
  };

  await expect(insertChatGptPromptText(prompt, undefined, {
    composer: async () => composer as never,
    verify: async expected => {
      if (attached !== expected) throw new Error("restored prefix drifted");
    },
    reanchor: async () => {},
  })).rejects.toThrow("restored prefix drifted");
  expect(contentEdits).toBe(2);
});

test("keeps a surrogate pair inside one bounded edit", async () => {
  const prompt = `${"x".repeat(CHATGPT_PROMPT_INSERT_CHUNK_CHARS - 1)}😀tail`;
  const inserted: string[] = [];
  const composer = {
    focus: async () => {},
    evaluate: async (_callback: unknown, value: string) => {
      inserted.push(value);
      return true;
    },
  };

  await insertChatGptPromptText(prompt, undefined, {
    composer: async () => composer as never,
    verify: async () => {},
    reanchor: async () => {},
  });
  expect(inserted[0]?.length).toBe(CHATGPT_PROMPT_INSERT_CHUNK_CHARS - 1);
  expect(inserted[1]?.startsWith("😀")).toBeTrue();
});

test("stops after abort before another bounded edit", async () => {
  const controller = new AbortController();
  const inserted: string[] = [];
  const composer = {
    focus: async () => {},
    evaluate: async (_callback: unknown, value: string) => {
      inserted.push(value);
      controller.abort();
      return true;
    },
  };

  await expect(insertChatGptPromptText(
    "x".repeat(CHATGPT_PROMPT_INSERT_CHUNK_CHARS * 2 + 1),
    controller.signal,
    {
      composer: async () => composer as never,
      verify: async () => {},
      reanchor: async () => {},
    },
  )).rejects.toThrow("aborted");
  expect(inserted).toHaveLength(1);
});
