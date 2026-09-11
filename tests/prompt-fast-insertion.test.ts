import { expect, test } from "bun:test";
import { insertChatGptPromptText } from "../src/adapters/chatgpt-web/prompt-insertion";
import { structuredCompactionHandoffInstruction } from "../src/adapters/chatgpt-web/native-compaction-control";
import { CHATGPT_PROMPT_INSERT_CHUNK_CHARS } from "../src/adapters/chatgpt-web/prompt-attachment-budget";

type FakeComposer = {
  composer: { focus(): Promise<void>; evaluate(callback: (element: HTMLElement, input: unknown) => unknown, input: unknown): Promise<unknown> };
  document: Document;
  editCommands(): number;
  setText(value: string): void;
  text(): string;
};

function fakeLexicalComposer(acceptEdit = true, onEdit?: () => void): FakeComposer {
  const { createDocument } = require("@mixmark-io/domino") as { createDocument: (html: string) => Document };
  const document = createDocument('<div id="composer"></div>') as Document & {
    createRange(): Range;
    execCommand(command: string, showUi: boolean, value?: string): boolean;
  };
  const composerElement = document.getElementById("composer")!;
  const text = document.createTextNode("");
  composerElement.appendChild(text);
  let selected = { start: 0, end: 0 };
  let editCommands = 0;

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
  document.execCommand = (command, _showUi, value = "") => {
    if (command !== "insertText") return false;
    editCommands += 1;
    if (!acceptEdit) return false;
    text.data = `${text.data.slice(0, selected.start)}${value}${text.data.slice(selected.end)}`;
    selected.start += value.length;
    selected.end = selected.start;
    onEdit?.();
    return true;
  };
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => composerElement });

  const selection = {
    get isCollapsed() { return selected.start === selected.end; },
    get anchorNode() { return text; },
    get focusNode() { return text; },
    removeAllRanges: () => {},
    addRange: (range: Range) => { selected = { start: range.startOffset, end: range.endOffset }; },
  };
  const view = {
    getSelection: () => selection,
  };
  Object.defineProperty(document, "defaultView", { configurable: true, value: view });

  return {
    composer: {
      focus: async () => {},
      evaluate: async (callback, input) => await callback(composerElement, input),
    },
    document,
    editCommands: () => editCommands,
    setText: value => { text.data = value; },
    text: () => text.data,
  };
}

async function insertWithFakeEditor(prompt: string, forceStructuredDirect = false): Promise<FakeComposer> {
  const editor = fakeLexicalComposer();
  const view = editor.document.defaultView!;
  const previous = { document: globalThis.document, NodeFilter: globalThis.NodeFilter, window: globalThis.window };
  Object.assign(globalThis, { document: editor.document, NodeFilter: { SHOW_TEXT: 4 }, window: view });
  try {
    await insertChatGptPromptText(prompt, undefined, {
      composer: async () => editor.composer as never,
      verify: async expected => expect(editor.text()).toBe(expected),
      reanchor: async () => {},
    }, { largeStructuredDirect: !forceStructuredDirect, forceStructuredDirect });
    return editor;
  } finally {
    Object.assign(globalThis, previous);
  }
}

test("REG-04: uses one exact direct edit for the short generated structured compaction prompt", async () => {
  const prompt = structuredCompactionHandoffInstruction({
    token: "control-token-0123456789abcdef",
    handoffId: "handoff-id-0123456789abcdef",
  });
  expect(prompt.length).toBeLessThan(CHATGPT_PROMPT_INSERT_CHUNK_CHARS * 2);
  expect(prompt.match(/[`*_#]/g)!.length).toBeGreaterThan(10);
  const editor = await insertWithFakeEditor(prompt, true);
  expect(editor.text()).toBe(prompt);
  expect(editor.editCommands()).toBe(1);
});

test("keeps the direct edit opt-in for callers that own an inline transport", async () => {
  const prompt = `header\n${"x".repeat(40_000)}`;
  const editor = fakeLexicalComposer();
  const view = editor.document.defaultView!;
  const previous = { document: globalThis.document, NodeFilter: globalThis.NodeFilter, window: globalThis.window };
  Object.assign(globalThis, { document: editor.document, NodeFilter: { SHOW_TEXT: 4 }, window: view });
  try {
    await insertChatGptPromptText(prompt, undefined, {
      composer: async () => editor.composer as never,
      verify: async expected => expect(editor.text()).toBe(expected),
      reanchor: async () => {},
    });
    expect(editor.editCommands()).toBeGreaterThan(1);
  } finally {
    Object.assign(globalThis, previous);
  }
});

test("fails closed when Lexical mutates the direct edit after its first readback", async () => {
  const prompt = compactSource;
  const editor = fakeLexicalComposer();
  const view = editor.document.defaultView!;
  const previous = { document: globalThis.document, NodeFilter: globalThis.NodeFilter, window: globalThis.window };
  Object.assign(globalThis, { document: editor.document, NodeFilter: { SHOW_TEXT: 4 }, window: view });
  let fullReadbacks = 0;
  try {
    await expect(insertChatGptPromptText(prompt, undefined, {
      composer: async () => editor.composer as never,
      verify: async expected => {
        expect(editor.text()).toBe(expected);
        if (expected === prompt && ++fullReadbacks === 1) queueMicrotask(() => editor.setText(`${prompt.slice(0, -1)}!`));
      },
      reanchor: async () => {},
    }, { largeStructuredDirect: true })).rejects.toThrow();
    expect(fullReadbacks).toBe(1);
  } finally {
    Object.assign(globalThis, previous);
  }
});

test("stops after a cancelled direct editor transaction settles", async () => {
  const prompt = compactSource;
  const controller = new AbortController();
  const editor = fakeLexicalComposer(true, () => controller.abort());
  const view = editor.document.defaultView!;
  const previous = { document: globalThis.document, NodeFilter: globalThis.NodeFilter, window: globalThis.window };
  Object.assign(globalThis, { document: editor.document, NodeFilter: { SHOW_TEXT: 4 }, window: view });
  let reanchored = false;
  try {
    await expect(insertChatGptPromptText(prompt, controller.signal, {
      composer: async () => editor.composer as never,
      verify: async expected => expect(editor.text()).toBe(expected),
      reanchor: async () => { reanchored = true; },
    }, { largeStructuredDirect: true })).rejects.toMatchObject({ name: "AbortError" });
    expect(editor.text()).toBe(prompt);
    expect(editor.editCommands()).toBe(1);
    expect(reanchored).toBeFalse();
  } finally {
    Object.assign(globalThis, previous);
  }
});

const freshHistory = (
  "<codex_context_json>\r\n"
  + '{"history":"user *literal* [link](target) `code`, tab:\\t, nbsp:\u00a0, pua:\uE000, emoji:\u{1F680}"}\r\n'
  + "</codex_context_json>\r\n"
).repeat(450);
const compactSource = (
  "<compact_task>Summarize this exact long source; do not continue the conversation.</compact_task>\n"
  + "## Historical turn\n- keep *constraints*\n- preserve `paths` and [evidence](local)\n"
).repeat(600);

for (const [name, prompt] of [
  ["fresh no-TTL full history", freshHistory],
  ["compact long source", compactSource],
] as const) {
  test(`uses one direct editor edit for ${name}`, async () => {
    expect(prompt.length).toBeGreaterThan(32_000);
    const editor = await insertWithFakeEditor(prompt);
    expect(editor.text()).toBe(prompt);
    expect(editor.editCommands()).toBe(1);
  });
}

test("fails closed when the editor rejects an oversized structured edit", async () => {
  const prompt = compactSource;
  const editor = fakeLexicalComposer(false);
  const view = editor.document.defaultView!;
  const previous = { document: globalThis.document, NodeFilter: globalThis.NodeFilter, window: globalThis.window };
  Object.assign(globalThis, { document: editor.document, NodeFilter: { SHOW_TEXT: 4 }, window: view });
  try {
    await expect(insertChatGptPromptText(prompt, undefined, {
      composer: async () => editor.composer as never,
      verify: async expected => expect(editor.text()).toBe(expected),
      reanchor: async () => {},
    }, { largeStructuredDirect: true })).rejects.toThrow("rejected the bounded plain-text edit");
    expect(editor.text()).toBe("");
    expect(editor.editCommands()).toBe(1);
  } finally {
    Object.assign(globalThis, previous);
  }
});
