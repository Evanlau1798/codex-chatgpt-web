import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import type { Locator } from "playwright-core";
import { ChatGptBrowserWorker, ChatGptCompletionTracker, CHATGPT_COMPLETION_SETTLE_MS } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptMarkdownBuffer, type ChatGptMarkdownSegment } from "../src/adapters/chatgpt-web/markdown";

const smokeHtml = readFileSync(new URL("./fixtures/chatgpt-dil-smoke.html", import.meta.url), "utf8");
type Snapshot = {
  responsePresent: boolean;
  visibleText: string;
  fullHtml: string;
  markdownSegments: ChatGptMarkdownSegment[];
  completionActionVisible: boolean;
  projection: {
    rootId?: string;
    boundaryProtocolPresent?: boolean;
    lastNodePresent: boolean;
    boundaryStart?: string;
    boundaryEnd?: string;
    lastMutationAt?: number;
    animations: [];
  };
  traceBlocks: { kind: string; text: string }[];
};

// Execute the production page callback, with only missing Domino browser APIs supplied.
async function snapshot(html: string): Promise<Snapshot> {
  const { createWindow } = require("@mixmark-io/domino");
  const window = createWindow(html);
  const innerText = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "innerText");
  const append = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "append");
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    configurable: true, get() { return this.textContent; },
  });
  Object.defineProperty(window.HTMLElement.prototype, "append", {
    configurable: true, value(this: HTMLElement, ...nodes: Node[]) { nodes.forEach(node => this.appendChild(node)); },
  });
  const collections = [window.document.querySelectorAll("div"), window.document.body.children].map(Object.getPrototypeOf);
  const iterators = collections.map(prototype => Object.getOwnPropertyDescriptor(prototype, Symbol.iterator));
  for (const prototype of collections) Object.defineProperty(prototype, Symbol.iterator, {
    configurable: true, value: Array.prototype[Symbol.iterator],
  });
  try {
    const context = createContext({
      document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
      Node: window.Node, NodeFilter: window.NodeFilter, performance: { timeOrigin: 1 },
      getComputedStyle: (element: HTMLElement) => ({
        display: element.style.display || "block", visibility: "visible", opacity: "1",
      }),
      MutationObserver: class { observe() {} },
    });
    const errors: unknown[] = [];
    const locator = {
      evaluate: async (callback: Function, options: unknown) => {
        try { return runInContext(`(${callback.toString()})`, context)(window.document.getElementById("turn"), options); }
        catch (error) { errors.push(error); throw error; }
      },
      page: () => ({ isClosed: () => false }),
    } as unknown as Locator;
    const worker = Object.create(ChatGptBrowserWorker.prototype) as {
      responseDomSnapshot(locator: Locator): Promise<Snapshot>;
    };
    const result = await worker.responseDomSnapshot(locator);
    expect(errors).toEqual([]);
    return result;
  } finally {
    collections.forEach((prototype, index) => {
      if (iterators[index]) Object.defineProperty(prototype, Symbol.iterator, iterators[index]!);
      else delete prototype[Symbol.iterator];
    });
    if (innerText) Object.defineProperty(window.HTMLElement.prototype, "innerText", innerText);
    else delete window.HTMLElement.prototype.innerText;
    if (append) Object.defineProperty(window.HTMLElement.prototype, "append", append);
    else delete window.HTMLElement.prototype.append;
  }
}

test("keeps an unfinished hyperlink buffered and detects changed destinations after delivery", async () => {
  const page = (href: string) => `<section id="turn"><div class="markdown"><p data-start="0" data-end="99"><strong><a${href}>Open report</a></strong>.</p><p data-start="100" data-end="115">Next paragraph.</p></div></section>`;
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  const pending = await snapshot(page(""));
  expect(buffer.observe(pending.markdownSegments, 0)).toBe("");
  const linked = await snapshot(page(' href="https://example.com/report#details"'));
  expect(buffer.observe(linked.markdownSegments, 1000)).toBe("**[Open report](https://example.com/report#details)**.");
  expect(buffer.finish().markdown).toBe("**[Open report](https://example.com/report#details)**.\n\nNext paragraph.");
  const changed = await snapshot(page(' href="https://example.com/different"'));
  buffer.observe(changed.markdownSegments, 2000);
  expect(buffer.currentSnapshotIsConsistent()).toBeFalse();
  expect(() => buffer.finish()).toThrow("completed text block");
});

test("captured DIL smoke response reaches Markdown delivery and stable completion", async () => {
  // Also cover a changed CSS module hash and nested Markdown without duplicate delivery.
  for (const html of [
    smokeHtml,
    smokeHtml.replaceAll("fv0XaG_", "changed_"),
    smokeHtml.replace('<p class="w6asjq_TextBase _85PZeG_Text">', '<p class="markdown">'),
    '<section id="turn"><div class="markdown"><p>CODEX WEB GPT READY</p></div><button data-testid="copy-turn-action-button"></button></section>',
  ]) {
    const response = await snapshot(html);
    expect(response.visibleText).toBe("CODEX WEB GPT READY");
    expect(response.completionActionVisible).toBeTrue();
    const buffer = new ChatGptMarkdownBuffer();
    buffer.observe(response.markdownSegments, 0);
    expect(buffer.finish().markdown).toBe("CODEX WEB GPT READY");
    const tracker = new ChatGptCompletionTracker();
    const state = { ...response, running: false, currentText: response.visibleText, currentHtml: response.fullHtml };
    expect(tracker.update({ ...state, running: true }, 0).status).toBe("waiting");
    expect(tracker.update(state, 1).status).toBe("waiting");
    expect(tracker.update(state, 1 + CHATGPT_COMPLETION_SETTLE_MS).status).toBe("complete");
    expect(response.traceBlocks.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: "answer", text: "CODEX WEB GPT READY" },
    ]);
  }
});

test("DIL response extraction preserves ownership, commentary and completion boundaries", async () => {
  for (const html of [
    smokeHtml.replace('data-message-author-role="assistant"', 'data-message-author-role="user"'),
    smokeHtml.replace("fv0XaG_DilResponseRoot", "unrelated-widget"),
    smokeHtml.replace('dir="auto"', 'dir="auto" style="display:none"'),
    smokeHtml.replace('class="grow"', 'class="grow" data-streaming-response-status="thinking"'),
    smokeHtml.replace('class="grow"', 'class="grow" data-testid="cot-v5"'),
  ]) {
    const response = await snapshot(html);
    expect(response.visibleText).toBe("");
    expect(response.completionActionVisible).toBeFalse();
  }
  const noCopy = await snapshot(smokeHtml.replace('data-testid="copy-turn-action-button"', 'data-testid="other-action"'));
  expect(noCopy.visibleText).toBe("CODEX WEB GPT READY");
  expect(noCopy.completionActionVisible).toBeFalse();
});

test("production DOM snapshot preserves structured JSON text inside a rendered code block", async () => {
  const content = 'line one\nline two\\n C:\\work\\file "quoted" _[brackets] 漢字';
  const raw = JSON.stringify({ content: null, tool_calls: [{ name: "write", arguments: { content } }] });
  const escaped = raw.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const response = await snapshot(`<section id="turn"><div class="markdown"><pre><code>${escaped}</code></pre></div>`
    + '<button data-testid="copy-turn-action-button"></button></section>');
  const buffer = new ChatGptMarkdownBuffer(undefined, 0, "visible-text");
  buffer.observe(response.markdownSegments, 0);
  expect(buffer.finish().markdown).toBe(raw);
  expect(JSON.parse(buffer.preview())).toEqual(JSON.parse(raw));
});
