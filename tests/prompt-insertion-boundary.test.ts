import { expect, test } from "bun:test";
import {
  CHATGPT_PROMPT_INSERT_CHUNK_CHARS,
  ChatGptBrowserWorker,
} from "../src/adapters/chatgpt-web/browser-worker";
import {
  restoreChatGptPromptChunkBoundary,
} from "../src/adapters/chatgpt-web/prompt-caret";

test("Markdown density does not increase bounded composer edit count", async () => {
  const { createDocument } = require("@mixmark-io/domino") as {
    createDocument: (html: string) => Document;
  };
  const pattern = "`*_~=[)";
  const prompt = pattern.repeat(Math.ceil((CHATGPT_PROMPT_INSERT_CHUNK_CHARS * 3 + 17) / pattern.length))
    .slice(0, CHATGPT_PROMPT_INSERT_CHUNK_CHARS * 3 + 17);
  const document = createDocument('<div id="composer"></div>') as Document & {
    execCommand: (command: string, showUi: boolean, value: string) => boolean;
  };
  const composerElement = document.getElementById("composer")!;
  const anchor = document.createTextNode("");
  composerElement.appendChild(anchor);
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => composerElement });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  let attached = "";
  const edits: string[] = [];
  document.execCommand = (command, _showUi, value) => {
    if (command !== "insertText" || typeof value !== "string") return false;
    edits.push(value);
    attached += value;
    return true;
  };
  Object.assign(globalThis, {
    document,
    window: {
      getSelection: () => ({
        isCollapsed: true,
        anchorNode: anchor,
        focusNode: anchor,
      }),
    },
  });
  const composer = {
    focus: async () => {},
    evaluate: async (callback: (element: HTMLElement, input: unknown) => unknown, input: unknown) => (
      await callback(composerElement, input)
    ),
  };
  const page = {
    keyboard: {
      insertText: async () => { throw new Error("bounded composer content must use the browser plain-text edit path"); },
    },
  };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    attachedPromptText: async () => attached,
    activeComposer: async () => composer,
    reanchorPromptCaret: async () => {},
  }) as {
    insertPromptText(page: unknown, text: string): Promise<void>;
  };

  try {
    await worker.insertPromptText(page, prompt);
    expect(attached).toBe(prompt);
    expect(edits.length).toBe(Math.ceil(prompt.length / CHATGPT_PROMPT_INSERT_CHUNK_CHARS));
    expect(edits.every(edit => edit.length <= CHATGPT_PROMPT_INSERT_CHUNK_CHARS)).toBeTrue();
  } finally {
    Object.assign(globalThis, { window: previousWindow, document: previousDocument });
  }
});

test("bounded composer edit fails closed when the browser rejects plain-text insertion", async () => {
  const composer = {
    focus: async () => {},
    evaluate: async () => false,
  };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    activeComposer: async () => composer,
  }) as {
    insertPromptText(page: unknown, text: string): Promise<void>;
  };

  await expect(worker.insertPromptText({
    keyboard: { insertText: async () => {} },
  }, "literal `markdown`"))
    .rejects.toThrow("plain-text");
});

test("bounded composer edit rejects a selection outside the active composer", async () => {
  const { createDocument } = require("@mixmark-io/domino") as {
    createDocument: (html: string) => Document;
  };
  const document = createDocument('<div id="composer"></div><div id="outside">outside</div>');
  const composerElement = document.getElementById("composer")!;
  const outside = document.getElementById("outside")!.firstChild!;
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => composerElement });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  Object.assign(globalThis, {
    document,
    window: {
      getSelection: () => ({
        isCollapsed: true,
        anchorNode: outside,
        focusNode: outside,
      }),
    },
  });
  const composer = {
    focus: async () => {},
    evaluate: async (callback: (element: HTMLElement, input: unknown) => unknown, input: unknown) => (
      await callback(composerElement, input)
    ),
  };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    activeComposer: async () => composer,
  }) as {
    insertPromptText(page: unknown, text: string): Promise<void>;
  };

  try {
    await expect(worker.insertPromptText({
      keyboard: { insertText: async () => {} },
    }, "plain text"))
      .rejects.toThrow("plain-text");
  } finally {
    Object.assign(globalThis, { window: previousWindow, document: previousDocument });
  }
});

test("chunk-boundary restoration fails closed when an asynchronous remount restores the marker", async () => {
  const { createDocument } = require("@mixmark-io/domino") as {
    createDocument: (html: string) => Document;
  };
  const marker = "\uF8FF";
  const document = createDocument(`<div id="composer">${marker}tail</div>`) as Document & {
    createRange: () => Range;
    execCommand: (command: string, showUi: boolean, value: string) => boolean;
  };
  const composerElement = document.getElementById("composer")!;
  const original = composerElement.firstChild!.cloneNode(true);
  let selected: { node?: Text; start?: number; end?: number } = {};
  document.createRange = () => ({
    setStart: (node: Text, offset: number) => { selected = { node, start: offset }; },
    setEnd: (_node: Text, offset: number) => { selected.end = offset; },
  } as unknown as Range);
  document.execCommand = (_command, _showUi, value) => {
    const node = selected.node;
    if (!node) return false;
    node.data = `${node.data.slice(0, selected.start)}${value}${node.data.slice(selected.end)}`;
    setTimeout(() => {
      if (node.parentNode === composerElement) composerElement.replaceChild(original.cloneNode(true), node);
    }, 0);
    return true;
  };
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNodeFilter = globalThis.NodeFilter;
  Object.assign(globalThis, {
    document,
    NodeFilter: { SHOW_TEXT: 4 },
    window: { getSelection: () => ({ removeAllRanges: () => {}, addRange: () => {} }) },
  });
  const composer = {
    focus: async () => {},
    evaluate: async (callback: (element: HTMLElement, input: unknown) => unknown, input: unknown) => (
      await callback(composerElement, input)
    ),
  };

  try {
    await expect(restoreChatGptPromptChunkBoundary(
      composer as never,
      { marker, value: " " },
    )).resolves.toBeFalse();
    expect(composerElement.textContent).toBe(`${marker}tail`);
  } finally {
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      NodeFilter: previousNodeFilter,
    });
  }
});

test("native prompt chunks keep boundary whitespace in the preceding edit", async () => {
  const prompt = `${"word ".repeat(4_000)}tail`;
  const inserted: string[] = [];
  let attached = "";
  const page = {};
  const composer = {
    focus: async () => {},
    evaluate: async (_callback: unknown, input: unknown) => {
      if (typeof input === "string") {
        if (input.length === 1 && input.charCodeAt(0) >= 0xE000 && input.charCodeAt(0) <= 0xF8FF) {
          return !attached.includes(input);
        }
        inserted.push(input);
        if (attached.endsWith("\u00A0") && input) attached = `${attached.slice(0, -1)} `;
        const committed = attached && input.startsWith(" ") ? input.slice(1) : input;
        attached += committed.endsWith(" ") ? `${committed.slice(0, -1)}\u00A0` : committed;
        return true;
      }
      const replacement = input as { marker: string; value: string };
      attached = attached.replace(replacement.marker, replacement.value);
      return true;
    },
  };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    attachedPromptText: async () => attached,
    activeComposer: async () => composer,
    reanchorPromptCaret: async () => {},
  }) as {
    insertPromptText(page: unknown, text: string): Promise<void>;
  };

  await worker.insertPromptText(page, prompt);

  expect(inserted.length).toBeGreaterThan(1);
  expect(inserted.slice(1).every(chunk => !chunk.startsWith(" "))).toBeTrue();
  expect(attached).toBe(prompt);
});
