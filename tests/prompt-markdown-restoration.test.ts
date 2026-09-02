import { expect, test } from "bun:test";
import {
  guardChatGptPromptMarkdown,
  planChatGptPromptMarkdownRestoration,
  restoreChatGptPromptMarkdown,
} from "../src/adapters/chatgpt-web/prompt-caret";

test("plans incident-sized Markdown restoration in bounded text ranges", () => {
  const pattern = "field_name=value) [literal](target) `code` *bold* ~=~ ";
  const prompt = pattern.repeat(Math.ceil(93_255 / pattern.length)).slice(0, 93_255);
  const guarded = guardChatGptPromptMarkdown(prompt);

  expect(guarded).toBeDefined();
  expect(guarded!.count).toBeGreaterThan(2_484);
  const ranges = planChatGptPromptMarkdownRestoration(
    guarded!.text,
    guarded!.replacements,
    16_000,
  );

  expect(ranges.length).toBeLessThanOrEqual(Math.ceil(prompt.length / 16_000) + 1);
  expect(ranges.every(range => range.end - range.start <= 16_000)).toBeTrue();
  expect(ranges.reduce((count, range) => count + range.count, 0)).toBe(guarded!.count);
  expect(ranges.every((range, index) => index === 0 || range.end <= ranges[index - 1]!.start)).toBeTrue();
});

test("restoration planning ignores unguarded text and rejects invalid bounds", () => {
  expect(planChatGptPromptMarkdownRestoration("plain text", [], 16_000)).toEqual([]);
  expect(() => planChatGptPromptMarkdownRestoration("\uE000", [
    { marker: "\uE000", value: "*", count: 1 },
  ], 0)).toThrow("positive");
});

test("restoration ranges carry trailing whitespace with one following code unit", () => {
  expect(planChatGptPromptMarkdownRestoration(
    "a\uE000 word",
    [{ marker: "\uE000", value: "*", count: 1 }],
    8,
  )).toEqual([{ start: 1, end: 4, count: 1 }]);
});

test("restores a short multi-block prompt in one editor mutation", async () => {
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
    expect(composerElement.lastChild?.textContent).toBe("A`one`\nB*two*\nC_three_");
  } finally {
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      NodeFilter: previousNodeFilter,
    });
  }
});
