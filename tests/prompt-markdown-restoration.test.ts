import { expect, test } from "bun:test";
import {
  CHATGPT_PROMPT_MARKDOWN_RESTORATION_BATCH_SIZE,
  guardChatGptPromptMarkdown,
  restoreChatGptPromptMarkdown,
} from "../src/adapters/chatgpt-web/prompt-caret";

test("guards every literal Markdown delimiter without changing prompt length", () => {
  const prompt = "field_name=value) [literal](target) `code` *bold* ~=~";
  const guarded = guardChatGptPromptMarkdown(prompt)!;
  expect(guarded.text).toHaveLength(prompt.length);
  expect(guarded.count).toBe(12);
  expect(guarded.replacements.map(replacement => replacement.value)).toEqual([
    "`", "*", "_", "~", "=", "[", ")",
  ]);
});

test("restores a short multi-block prompt without selecting its connector", async () => {
  const { createDocument } = require("@mixmark-io/domino") as {
    createDocument: (html: string) => Document;
  };
  const document = createDocument(
    '<div id="composer"><span data-id="plugin:test" data-keyword="Codex Native2">Codex Native2</span>'
      + '<p>A\u2060one\u2060</p><p>B\uE000two\uE000</p><p>C\uE001three\uE001</p></div>',
  ) as Document & {
    createRange: () => Range;
    execCommand: (command: string, showUi: boolean, value: string) => boolean;
  };
  const composerElement = document.getElementById("composer")!;
  let selected: { startNode?: Node; start?: number; endNode?: Node; end?: number } = {};
  document.createRange = () => ({
    setStart: (node: Node, offset: number) => { selected = { startNode: node, start: offset }; },
    setEnd: (node: Node, offset: number) => { selected.endNode = node; selected.end = offset; },
  } as unknown as Range);
  document.execCommand = (_command, _showUi, value) => {
    if (selected.startNode && selected.startNode !== selected.endNode) {
      Array.from(composerElement.children)
        .filter(child => !child.matches('[data-id^="plugin:"][data-keyword]'))
        .forEach(child => child.remove());
      composerElement.appendChild(document.createTextNode(value ?? ""));
    } else if (selected.startNode?.nodeType === 3) {
      const node = selected.startNode as Text;
      node.data = `${node.data.slice(0, selected.start ?? 0)}${value}${node.data.slice(selected.end ?? 0)}`;
    }
    return true;
  };
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNodeFilter = globalThis.NodeFilter;
  Object.assign(globalThis, {
    document,
    NodeFilter: { SHOW_TEXT: 4 },
    window: {
      getSelection: () => ({
        removeAllRanges: () => {},
        addRange: () => {},
      }),
    },
  });
  let evaluateCalls = 0;
  const composer = {
    focus: async () => {},
    evaluate: async (callback: (element: HTMLElement, input: unknown) => unknown, input: unknown) => {
      evaluateCalls += 1;
      return await callback(composerElement, input);
    },
  };

  try {
    await expect(restoreChatGptPromptMarkdown(composer as never, [
      { marker: "\u2060", value: "`", count: 2 },
      { marker: "\uE000", value: "*", count: 2 },
      { marker: "\uE001", value: "_", count: 2 },
    ], 6)).resolves.toBeTrue();
    expect(evaluateCalls).toBe(2);
    const connector = composerElement.querySelector('[data-keyword="Codex Native2"]')!;
    expect(connector).not.toBeNull();
    expect(connector.contains(selected.startNode ?? null)).toBeFalse();
    expect(connector.contains(selected.endNode ?? null)).toBeFalse();
    expect(Array.from(composerElement.children)
      .filter(child => !child.matches('[data-id^="plugin:"][data-keyword]'))
      .map(child => child.textContent ?? "")
      .join("\n")).toBe("A`one`\nB*two*\nC_three_");
  } finally {
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      NodeFilter: previousNodeFilter,
    });
  }
});

test("restores an incident-sized Markdown prompt without bulk Lexical replacement", async () => {
  const { createDocument } = require("@mixmark-io/domino") as {
    createDocument: (html: string) => Document;
  };
  const pattern = "field_name=value) [literal](target) `code` *bold* ~=~ payload ";
  const prompt = pattern.repeat(Math.ceil(17_587 / pattern.length)).slice(0, 17_587);
  const guarded = guardChatGptPromptMarkdown(prompt)!;
  const document = createDocument(
    '<div id="composer"><span data-id="plugin:test" data-keyword="Codex Native2">Codex Native2</span></div>',
  ) as Document & {
    createRange: () => Range;
    execCommand: (command: string, showUi: boolean, value: string) => boolean;
  };
  const composerElement = document.getElementById("composer")!;
  composerElement.appendChild(document.createTextNode(guarded.text));
  let selected: { node?: Text; start?: number; end?: number } = {};
  let currentBatchOperations = 0;
  const batchOperations: number[] = [];
  document.createRange = () => ({
    setStart: (node: Text, offset: number) => { selected = { node, start: offset }; },
    setEnd: (node: Text, offset: number) => { selected.end = offset; },
  } as unknown as Range);
  let maxReplacementChars = 0;
  document.execCommand = (_command, _showUi, value) => {
    const replacement = value ?? "";
    currentBatchOperations += 1;
    maxReplacementChars = Math.max(maxReplacementChars, replacement.length);
    if (replacement.length !== 1 || !selected.node) return false;
    selected.node.data = `${selected.node.data.slice(0, selected.start)}${replacement}${selected.node.data.slice(selected.end)}`;
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
  let evaluateCalls = 0;
  let remounted = false;
  const composer = {
    focus: async () => {},
    evaluate: async (callback: (element: HTMLElement, input: unknown) => unknown, input: unknown) => {
      evaluateCalls += 1;
      currentBatchOperations = 0;
      const result = await callback(composerElement, input);
      batchOperations.push(currentBatchOperations);
      if (!remounted && currentBatchOperations === CHATGPT_PROMPT_MARKDOWN_RESTORATION_BATCH_SIZE) {
        const current = composerElement.lastChild!;
        composerElement.replaceChild(current.cloneNode(true), current);
        remounted = true;
      }
      return result;
    },
  };

  try {
    expect(guarded.count).toBeGreaterThan(3_000);
    await expect(restoreChatGptPromptMarkdown(
      composer as never,
      guarded.replacements,
      guarded.count,
      16_000,
    )).resolves.toBeTrue();
    expect(composerElement.lastChild?.textContent).toBe(prompt);
    expect(maxReplacementChars).toBe(1);
    expect(remounted).toBeTrue();
    expect(evaluateCalls).toBe(Math.ceil(guarded.count / CHATGPT_PROMPT_MARKDOWN_RESTORATION_BATCH_SIZE) + 1);
    expect(Math.max(...batchOperations)).toBe(CHATGPT_PROMPT_MARKDOWN_RESTORATION_BATCH_SIZE);
  } finally {
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      NodeFilter: previousNodeFilter,
    });
  }
});

test("fails closed for invalid restoration progress and stops after abort", async () => {
  const replacement = [{ marker: "\u2060", value: "`", count: 1 }];
  for (const progress of [[0], [-1], [2], [1, false]] as const) {
    let call = 0;
    const composer = {
      focus: async () => {},
      evaluate: async () => progress[call++],
    };
    await expect(restoreChatGptPromptMarkdown(composer as never, replacement, 1)).resolves.toBeFalse();
  }

  const controller = new AbortController();
  let calls = 0;
  const composer = {
    focus: async () => {},
    evaluate: async () => {
      calls += 1;
      controller.abort(new Error("cancelled"));
      return CHATGPT_PROMPT_MARKDOWN_RESTORATION_BATCH_SIZE;
    },
  };
  await expect(restoreChatGptPromptMarkdown(
    composer as never,
    replacement,
    CHATGPT_PROMPT_MARKDOWN_RESTORATION_BATCH_SIZE + 1,
    16_000,
    controller.signal,
  )).rejects.toThrow("cancelled");
  expect(calls).toBe(1);
});
