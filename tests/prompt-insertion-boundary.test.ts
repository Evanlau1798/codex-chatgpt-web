import { expect, test } from "bun:test";
import {
  CHATGPT_PROMPT_INSERT_CHUNK_CHARS,
  ChatGptBrowserWorker,
} from "../src/adapters/chatgpt-web/browser-worker";
import {
  insertChatGptComposerPlainText,
  restoreChatGptPromptChunkBoundary,
} from "../src/adapters/chatgpt-web/prompt-caret";

test("single-line Markdown density does not increase bounded composer edit count", async () => {
  const { createDocument } = require("@mixmark-io/domino") as {
    createDocument: (html: string) => Document;
  };
  const pattern = '`json` {"key": ["*value*", "~x~", "a_b=c", "call()"]} ';
  const prompt = pattern.repeat(Math.ceil((CHATGPT_PROMPT_INSERT_CHUNK_CHARS * 6 + 17) / pattern.length))
    .slice(0, CHATGPT_PROMPT_INSERT_CHUNK_CHARS * 6 + 17);
  const document = createDocument('<div id="composer"></div>') as Document & {
    createRange: () => Range;
    execCommand: (command: string, showUi: boolean, value: string) => boolean;
  };
  let composerElement = document.getElementById("composer")!;
  let anchor = document.createTextNode("");
  composerElement.appendChild(anchor);
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => composerElement });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNodeFilter = globalThis.NodeFilter;
  let selected = { start: 0, end: 0 };
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
  const edits: string[] = [];
  let remounts = 0;
  document.execCommand = (command, _showUi, value) => {
    if (command !== "insertText" || typeof value !== "string") return false;
    edits.push(value);
    anchor.data = `${anchor.data.slice(0, selected.start)}${value}${anchor.data.slice(selected.end)}`;
    selected = { start: selected.start + value.length, end: selected.start + value.length };
    return true;
  };
  Object.assign(globalThis, {
    document,
    NodeFilter: { SHOW_TEXT: 4 },
    window: {
      getSelection: () => ({
        get isCollapsed() { return selected.start === selected.end; },
        anchorNode: anchor,
        focusNode: anchor,
        removeAllRanges: () => {},
        addRange: (range: Range) => {
          selected = { start: range.startOffset, end: range.endOffset };
        },
      }),
    },
  });
  const composer = {
    focus: async () => {},
    evaluate: async (callback: (element: HTMLElement, input: unknown) => unknown, input: unknown) => {
      const result = await callback(composerElement, input);
      if (typeof input === "object" && input !== null && !Array.isArray(input)) {
        const replacement = document.createElement("div");
        const replacementText = document.createTextNode(anchor.data);
        replacement.id = "composer";
        replacement.appendChild(replacementText);
        composerElement.parentNode?.replaceChild(replacement, composerElement);
        composerElement = replacement;
        anchor = replacementText;
        remounts += 1;
      }
      return result;
    },
  };
  const page = {
    keyboard: {
      insertText: async () => { throw new Error("bounded composer content must use the browser plain-text edit path"); },
    },
  };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    attachedPromptText: async () => anchor.data,
    activeComposer: async () => composer,
    reanchorPromptCaret: async () => { selected = { start: anchor.data.length, end: anchor.data.length }; },
  }) as {
    insertPromptText(page: unknown, text: string): Promise<void>;
  };

  try {
    await worker.insertPromptText(page, prompt);
    expect(anchor.data).toBe(prompt);
    expect(remounts).toBeGreaterThan(1);
    expect(edits.length).toBeLessThan(30);
    expect(edits.every(edit => edit.length <= CHATGPT_PROMPT_INSERT_CHUNK_CHARS)).toBeTrue();
  } finally {
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      NodeFilter: previousNodeFilter,
    });
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

test("bounded composer edit rejects non-collapsed selection and wrong active element", async () => {
  const { createDocument } = require("@mixmark-io/domino") as {
    createDocument: (html: string) => Document;
  };
  const document = createDocument('<div id="composer">text</div><button id="outside"></button>');
  const composerElement = document.getElementById("composer")!;
  const outside = document.getElementById("outside")!;
  let active: Element = composerElement;
  let collapsed = false;
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
  const previous = { document: globalThis.document, window: globalThis.window };
  Object.assign(globalThis, {
    document,
    window: {
      getSelection: () => ({
        isCollapsed: collapsed,
        anchorNode: composerElement.firstChild,
        focusNode: composerElement.firstChild,
      }),
    },
  });
  const composer = {
    focus: async () => {},
    evaluate: async (callback: (element: HTMLElement, input: unknown) => unknown, input: unknown) => (
      callback(composerElement, input)
    ),
  };

  try {
    await expect(insertChatGptComposerPlainText(composer as never, "value"))
      .rejects.toThrow("plain-text");
    collapsed = true;
    active = outside;
    await expect(insertChatGptComposerPlainText(composer as never, "value"))
      .rejects.toThrow("plain-text");
  } finally {
    Object.assign(globalThis, previous);
  }
});

test("bounded composer edit preserves multiline PUA text and the connector pill", async () => {
  const { createDocument } = require("@mixmark-io/domino") as {
    createDocument: (html: string) => Document;
  };
  const document = createDocument(
    '<div id="composer"><span data-id="plugin:test" data-keyword="Codex Native2">Codex Native2</span></div>',
  ) as Document & {
    createRange: () => Range;
    execCommand: (command: string, showUi: boolean, value: string) => boolean;
  };
  const composerElement = document.getElementById("composer")!;
  const connector = composerElement.firstChild!;
  const text = document.createTextNode("");
  composerElement.appendChild(text);
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => composerElement });
  let selected = { start: 0, end: 0 };
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
    text.data = `${text.data.slice(0, selected.start)}${value}${text.data.slice(selected.end)}`;
    selected = { start: selected.start + value.length, end: selected.start + value.length };
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
        anchorNode: text,
        focusNode: text,
        removeAllRanges: () => {},
        addRange: (range: Range) => { selected = { start: range.startOffset, end: range.endOffset }; },
      }),
    },
  });
  const composer = {
    focus: async () => {},
    evaluate: async (callback: (element: HTMLElement, input: unknown) => unknown, input: unknown) => (
      await callback(composerElement, input)
    ),
  };
  const prompt = " \n\uE000 literal *bold* [value])\n\uF8FF ";

  try {
    await insertChatGptComposerPlainText(composer as never, prompt);
    expect(text.data).toBe(prompt);
    expect(connector.textContent).toBe("Codex Native2");
  } finally {
    Object.assign(globalThis, previous);
  }
});

test("bounded Markdown restoration rejects an inconsistent marker recount", async () => {
  const composer = {
    focus: async () => {},
    evaluate: async (_callback: unknown, input: unknown) => {
      if (typeof input === "string") return true;
      if (Array.isArray(input)) return 1;
      return 2;
    },
  };

  await expect(insertChatGptComposerPlainText(composer as never, "**"))
    .rejects.toThrow("could not preserve literal Markdown");
});

test("structured Markdown restoration reports a rejected exact edit without prompt content", async () => {
  const composer = {
    focus: async () => {},
    evaluate: async (_callback: unknown, input: unknown) => typeof input === "string" ? true : -1,
  };

  const failure = await insertChatGptComposerPlainText(composer as never, "*private-sentinel*\n")
    .catch(error => error as Error);
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error("Expected structured Markdown restoration to fail");
  expect(failure.message).toContain("strategy=exact, initialMarkers=2, remainingMarkers=2, batches=1");
  expect(failure.message).not.toContain("private-sentinel");
});

test("structured Markdown restoration stops after aborting its current exact batch", async () => {
  const controller = new AbortController();
  let evaluations = 0;
  const composer = {
    focus: async () => {},
    evaluate: async (_callback: unknown, input: unknown) => {
      evaluations += 1;
      if (typeof input === "string") return true;
      controller.abort(new DOMException("stopped", "AbortError"));
      return 1;
    },
  };

  await expect(insertChatGptComposerPlainText(composer as never, "*value*\n", controller.signal))
    .rejects.toThrow("stopped");
  expect(evaluations).toBe(2);
});

test("bounded Markdown restoration does not split its trailing surrogate pair", async () => {
  const { createDocument } = require("@mixmark-io/domino") as {
    createDocument: (html: string) => Document;
  };
  const document = createDocument('<div id="composer"></div>') as Document & {
    createRange: () => Range;
    execCommand: (command: string, showUi: boolean, value: string) => boolean;
  };
  const composerElement = document.getElementById("composer")!;
  const text = document.createTextNode("");
  composerElement.appendChild(text);
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => composerElement });
  let selected = { start: 0, end: 0 };
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
  document.execCommand = (_command, _showUi, value) => {
    if (typeof value !== "string") return false;
    const previous = text.data.charCodeAt(selected.end - 1);
    const next = text.data.charCodeAt(selected.end);
    if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) return false;
    text.data = `${text.data.slice(0, selected.start)}${value}${text.data.slice(selected.end)}`;
    selected = { start: selected.start + value.length, end: selected.start + value.length };
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
        anchorNode: text,
        focusNode: text,
        removeAllRanges: () => {},
        addRange: (range: Range) => { selected = { start: range.startOffset, end: range.endOffset }; },
      }),
    },
  });
  const composer = {
    focus: async () => {},
    evaluate: async (callback: (element: HTMLElement, input: unknown) => unknown, input: unknown) => (
      await callback(composerElement, input)
    ),
  };

  try {
    await insertChatGptComposerPlainText(composer as never, "*😀");
    expect(text.data).toBe("*😀");
  } finally {
    Object.assign(globalThis, previous);
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
