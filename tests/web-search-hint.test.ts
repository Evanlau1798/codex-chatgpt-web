import { expect, test } from "bun:test";
import { CHATGPT_COMPOSER_DOCUMENT_END_KEY, ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import {
  CHATGPT_COMPOSER_MENU_ROW_SELECTOR,
  CHATGPT_WEB_SEARCH_HINT_SELECTOR,
  selectChatGptWebSearchHint,
} from "../src/adapters/chatgpt-web/web-search-hint";

class TimeoutError extends Error {
  override name = "TimeoutError";
}

function hintFixture(options: { hintCounts: number[]; rowVisible: boolean; rowCount?: number }) {
  const calls: string[] = [];
  const hintCounts = [...options.hintCounts];
  const hint = {
    count: async () => hintCounts.shift() ?? 0,
    waitFor: async () => {
      calls.push("hint:waitFor");
      if ((hintCounts[0] ?? 0) === 0) throw new TimeoutError("hint missing");
    },
  };
  const composer = {
    locator: (selector: string) => {
      expect(selector).toBe(CHATGPT_WEB_SEARCH_HINT_SELECTOR);
      return hint;
    },
  };
  const row = {
    waitFor: async () => {
      calls.push("row:waitFor");
      if (!options.rowVisible) throw new TimeoutError("row missing");
    },
    count: async () => options.rowCount ?? 1,
    click: async () => { calls.push("row:click"); },
  };
  const textMatcher = { exact: true, text: "Web search" };
  const page = {
    getByTestId: (testId: string) => {
      expect(testId).toBe("composer-plus-btn");
      return {
        filter: (filterOptions: { visible: boolean }) => {
          expect(filterOptions).toEqual({ visible: true });
          return {
            count: async () => 1,
            focus: async () => { calls.push("plus:focus"); },
            press: async (key: string) => { calls.push(`plus:${key}`); },
          };
        },
      };
    },
    getByText: (text: string, textOptions: { exact: boolean }) => {
      expect(text).toBe("Web search");
      expect(textOptions).toEqual({ exact: true });
      return textMatcher;
    },
    locator: (selector: string) => {
      expect(selector).toBe(CHATGPT_COMPOSER_MENU_ROW_SELECTOR);
      return {
        filter: (hasOptions: { has: unknown }) => {
          expect(hasOptions).toEqual({ has: textMatcher });
          return {
            filter: (visibleOptions: { visible: boolean }) => {
              expect(visibleOptions).toEqual({ visible: true });
              return row;
            },
          };
        },
      };
    },
    keyboard: {
      press: async (key: string) => { calls.push(`keyboard:${key}`); },
    },
  };
  return { page, composer, calls };
}

test("Web search hint opens the plus menu, activates the exact row, and verifies the inserted pill", async () => {
  const { page, composer, calls } = hintFixture({ hintCounts: [0, 1, 1], rowVisible: true });
  const checkpoints: string[] = [];

  await selectChatGptWebSearchHint(page as never, composer as never, async checkpoint => { checkpoints.push(checkpoint); });

  expect(calls).toEqual(["plus:focus", "plus:Enter", "row:waitFor", "row:click", "hint:waitFor"]);
  expect(checkpoints).toEqual(["web-search-menu-visible", "web-search-hint-selected"]);
});

test("Web search hint is idempotent when the composer already carries the pill", async () => {
  const { page, composer, calls } = hintFixture({ hintCounts: [1], rowVisible: true });
  const checkpoints: string[] = [];

  await selectChatGptWebSearchHint(page as never, composer as never, async checkpoint => { checkpoints.push(checkpoint); });

  expect(calls).toEqual([]);
  expect(checkpoints).toEqual(["web-search-hint-already-selected"]);
});

test("Web search hint fails closed and dismisses the menu when the row is missing", async () => {
  const { page, composer, calls } = hintFixture({ hintCounts: [0], rowVisible: false });

  await expect(selectChatGptWebSearchHint(page as never, composer as never))
    .rejects.toThrow("ChatGPT composer plus menu did not expose a Web search row");
  expect(calls).toEqual(["plus:focus", "plus:Enter", "row:waitFor", "keyboard:Escape"]);
});

test("Web search hint fails closed when activating the row inserts no pill", async () => {
  const { page, composer, calls } = hintFixture({ hintCounts: [0, 0, 0], rowVisible: true });

  await expect(selectChatGptWebSearchHint(page as never, composer as never))
    .rejects.toThrow("ChatGPT composer did not insert the Web search hint");
  expect(calls).toEqual(["plus:focus", "plus:Enter", "row:waitFor", "row:click", "hint:waitFor"]);
});

test("Web search hint rejects duplicate menu rows before activating anything", async () => {
  const { page, composer, calls } = hintFixture({ hintCounts: [0], rowVisible: true, rowCount: 2 });

  await expect(selectChatGptWebSearchHint(page as never, composer as never))
    .rejects.toThrow("ChatGPT composer plus menu exposed duplicate Web search rows");
  expect(calls).toEqual(["plus:focus", "plus:Enter", "row:waitFor", "keyboard:Escape"]);
});

type AttachPrompt = (
  page: unknown,
  prompt: string,
  localTools: boolean,
  captureDiagnostic?: (checkpoint: string) => Promise<void>,
  reuseConnector?: boolean,
  abortSignal?: AbortSignal,
  catalogRefreshAvailable?: boolean,
  connectorAttemptBudget?: { triggerAttempts: number },
  webSearch?: boolean,
) => Promise<void>;

const attachPrompt = (ChatGptBrowserWorker.prototype as unknown as { attachPrompt: AttachPrompt }).attachPrompt;

test("browser-only prompt attachment selects the Web search hint between clearing and inserting the prompt", async () => {
  const calls: Array<string | string[]> = [];
  const composer = {
    fill: async (value: string) => { calls.push(["fill", value]); },
    focus: async () => { calls.push("composer:focus"); },
  };
  const page = { keyboard: { press: async (key: string) => { calls.push(`keyboard:${key}`); } } };
  const worker = {
    activeComposer: async () => composer,
    selectWebSearchHint: async (hintPage: unknown, hintComposer: unknown) => {
      expect(hintPage).toBe(page);
      expect(hintComposer).toBe(composer);
      calls.push("hint:select");
    },
    insertPromptText: async (_page: unknown, text: string) => { calls.push(["insert", text]); },
    assertPromptAttached: async (_page: unknown, prompt: string) => { calls.push(["assert", prompt]); },
  };

  await attachPrompt.call(worker, page, "Summarize the release notes", false, undefined, false, undefined, false, { triggerAttempts: 0 }, true);

  expect(calls).toEqual([
    ["fill", ""],
    "composer:focus",
    "hint:select",
    "composer:focus",
    `keyboard:${CHATGPT_COMPOSER_DOCUMENT_END_KEY}`,
    ["insert", " Summarize the release notes"],
    ["assert", "Summarize the release notes"],
  ]);
});

test("prompt attachment without the flag never touches the plus menu", async () => {
  const calls: Array<string | string[]> = [];
  const composer = {
    fill: async (value: string) => { calls.push(["fill", value]); },
    focus: async () => { calls.push("composer:focus"); },
  };
  const worker = {
    activeComposer: async () => composer,
    selectWebSearchHint: async () => { calls.push("hint:select"); },
    insertPromptText: async (_page: unknown, text: string) => { calls.push(["insert", text]); },
    assertPromptAttached: async (_page: unknown, prompt: string) => { calls.push(["assert", prompt]); },
  };

  await attachPrompt.call(worker, {}, "Plain prompt", false);

  expect(calls).toEqual([["fill", ""], "composer:focus", ["insert", "Plain prompt"], ["assert", "Plain prompt"]]);
});

test("prompt verification strips the observed Web search pill before comparing the composer text", async () => {
  const { createDocument } = require("@mixmark-io/domino") as {
    createDocument: (html: string) => Document;
  };
  // Composer markup captured from chatgpt.com Temporary Chat on 2026-09-06 after activating the
  // "Web search" plus-menu row and appending the prompt after the pill.
  const document = createDocument(
    '<div id="prompt-textarea" contenteditable="true" role="textbox"><p dir="auto">'
      + '<span data-inline-selection-pill-cursor-target="" aria-hidden="true" contenteditable="false">\uFEFF</span>'
      + '<span contenteditable="false" data-inline-selection-pill="" data-id="search" data-symbol="ecosystemMention"'
      + ' data-keyword="Web search" data-system-hint-type="search">'
      + '<span class="max-w-[16rem] self-baseline truncate">Web search</span></span> Summarize the release notes</p></div>',
  );
  const composerElement = document.getElementById("prompt-textarea")!;
  const attachedPromptText = (ChatGptBrowserWorker.prototype as unknown as {
    attachedPromptText(page: unknown): Promise<string>;
  }).attachedPromptText;
  const worker = {
    activeComposer: async () => ({
      evaluate: async (callback: (element: Element) => string) => callback(composerElement),
    }),
  };

  expect(await attachedPromptText.call(worker, {})).toBe("Summarize the release notes");
  expect(composerElement.textContent).toContain("Web search");
});

test("prompt attachment refuses to combine the Web search hint with the Codex connector", async () => {
  const worker = {
    activeComposer: async () => { throw new Error("composer must not be touched"); },
  };

  await expect(attachPrompt.call(worker, {}, "prompt", true, undefined, false, undefined, false, { triggerAttempts: 0 }, true))
    .rejects.toThrow("ChatGPT Web search hint cannot be combined with the Codex connector in one turn");
});
