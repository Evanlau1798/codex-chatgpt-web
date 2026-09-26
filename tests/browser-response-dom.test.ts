import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import type { Locator } from "playwright-core";
import { ChatGptBrowserWorker, ChatGptCompletionTracker, ChatGptVisibleTraceTracker, CHATGPT_COMPLETION_SETTLE_MS } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptMarkdownBuffer, type ChatGptMarkdownSegment } from "../src/adapters/chatgpt-web/markdown";

const smokeHtml = readFileSync(new URL("./fixtures/chatgpt-dil-smoke.html", import.meta.url), "utf8");
const powerCompleteHtml = readFileSync(new URL("./fixtures/chatgpt-power-complete.html", import.meta.url), "utf8");
const powerStreamingHtml = readFileSync(new URL("./fixtures/chatgpt-power-streaming.html", import.meta.url), "utf8");
// These captures are also edited as strings below. Windows checkouts use CRLF;
// normalize before inserting test variants so they exercise the same DOM everywhere.
const powerActivityHtml = readFileSync(new URL("./fixtures/chatgpt-power-activity.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const activitySummariesHtml = readFileSync(new URL("./fixtures/chatgpt-activity-summaries.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
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
  traceBlocks: { kind: "answer" | "commentary" | "status"; text: string }[];
};

// Execute the production page callback, with only missing Domino browser APIs supplied.
async function snapshot(html: string, later?: { afterMs: number; selector: string; text?: string; remove?: boolean; remount?: boolean },
  observe?: (state: Snapshot) => void): Promise<Snapshot> {
  const { createWindow } = require("@mixmark-io/domino");
  const window = createWindow(html);
  let now = 1_000;
  const observers: Array<{ root: Element; notify: () => void }> = [];
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
      Date: later ? class extends Date { static now() { return now; } } : Date,
      MutationObserver: class {
        constructor(private readonly notify: () => void) {}
        observe(root: Element) { observers.push({ root, notify: this.notify }); }
      },
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
    let result = await worker.responseDomSnapshot(locator);
    observe?.(result);
    if (later) {
      now += later.afterMs;
      const root = window.document.querySelector(later.selector);
      expect(root).not.toBeNull();
      if (later.remove) root!.parentNode!.removeChild(root!);
      else if (later.remount) root!.parentNode!.replaceChild(root!.cloneNode(true), root!);
      else {
        root!.textContent = later.text!;
        for (const observer of observers) if (observer.root === root) observer.notify();
      }
      result = await worker.responseDomSnapshot(locator);
      observe?.(result);
    }
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

test("captured Activity progress is commentary before any assistant answer exists", async () => {
  const progress = await snapshot(powerActivityHtml);
  expect(progress.responsePresent).toBeTrue();
  expect(progress.markdownSegments).toEqual([]);
  expect(progress.completionActionVisible).toBeFalse();
  expect(progress.traceBlocks.filter(block => block.kind === "commentary").map(block => block.text)).toEqual(["Text 5\nText 6\nText 4\nText 8"]);
  const marker = '<span hidden="" data-chatgpt-agent-turn-start="">\n</span>';
  expect(powerActivityHtml).toContain(marker);
  const combined = powerActivityHtml.replace(marker, marker + '<div data-content-search-unit-key="answer"><h4 data-conversation-role="assistant"></h4><div data-markdown-text-style="assistant-message"><p>Final answer.</p></div></div>');
  const answer = await snapshot(combined);
  expect(answer.visibleText).toBe("Final answer.");
  expect(answer.traceBlocks.some(block => block.kind === "commentary")).toBeTrue();
});

test("captured activity summaries use the status stream and keep actual commentary and answers separate", async () => {
  const result = await snapshot(activitySummariesHtml);
  expect(result.visibleText).toBe("answer 1");
  expect(result.traceBlocks.filter(block => block.kind === "status").map(block => block.text))
    .toEqual(Array.from({ length: 10 }, (_, index) => `status ${index + 1}`));
  expect(result.traceBlocks.filter(block => block.kind === "commentary").map(block => block.text))
    .toEqual(["commentary 1", "commentary 2"]);
  const tracker = new ChatGptVisibleTraceTracker(0);
  const events = tracker.observe(result.traceBlocks, true);
  expect(events.map(event => event.kind)).toEqual([
    "reasoning", "commentary", ...Array(8).fill("reasoning"), "commentary", "reasoning",
  ]);
  expect(tracker.observe(result.traceBlocks, true)).toEqual([]);

  // Text, colour, and header placement do not determine the channel. The final
  // answer owns its own unit even if its renderer uses the same tone attribute.
  const changed = await snapshot(activitySummariesHtml
    .replaceAll("status 1", "commentary 1")
    .replace('data-markdown-text-style="assistant-message">\n<p>answer 1',
      'data-markdown-text-style="assistant-message" data-markdown-text-tone="tertiary">\n<p>answer 1'));
  expect(changed.visibleText).toBe("answer 1");
  expect(changed.traceBlocks.filter(block => block.kind === "commentary").map(block => block.text))
    .toEqual(["commentary 1", "commentary 2"]);
  expect(changed.traceBlocks.find(block => block.kind === "status")?.text).toBe("commentary 1");

  const hidden = await snapshot(activitySummariesHtml
    .replace('<div data-markdown-text-style="assistant-message" data-markdown-text-tone="tertiary">',
      '<div style="display:none"><div data-markdown-text-style="assistant-message" data-markdown-text-tone="tertiary">')
    .replace('<p>status 1</p>\n</div>', '<p>status 1</p>\n</div></div>'));
  expect(hidden.traceBlocks.some(block => block.text === "status 1")).toBeFalse();
});

test("multi-root answer settlement tracks mutations in every contributing answer root", async () => {
  const response = await snapshot(
    '<section id="turn"><div class="markdown" id="first"><p>Review in</p></div>'
      + '<div class="markdown" id="last"><p>Stable tail.</p></div>'
      + '<button data-testid="copy-turn-action-button"></button></section>',
    { afterMs: 3_000, selector: "#first", text: "Review in progress." },
  );
  expect(response.visibleText).toContain("Review in progress.");
  expect(response.completionActionVisible).toBeTrue();
  expect(response.projection.lastMutationAt).toBe(4_000);
});

test("multi-root answer settlement resets when an earlier answer root disappears", async () => {
  const response = await snapshot(
    '<section id="turn"><div class="markdown" id="first"><p>Review in progress.</p></div>'
      + '<div class="markdown" id="last"><p>Stable tail.</p></div>'
      + '<button data-testid="copy-turn-action-button"></button></section>',
    { afterMs: 3_000, selector: "#first", remove: true },
  );
  expect(response.visibleText).toBe("Stable tail.");
  expect(response.completionActionVisible).toBeTrue();
  expect(response.projection.lastMutationAt).toBe(4_000);
});

test("an equal-content remount of an earlier answer root restarts the full completion window", async () => {
  const states: Snapshot[] = [];
  await snapshot(
    '<section id="turn"><div class="markdown" id="first"><p>First block.</p></div>'
      + '<div class="markdown" id="last"><p>Stable tail.</p></div>'
      + '<button data-testid="copy-turn-action-button"></button></section>',
    { afterMs: 1_900, selector: "#first", remount: true }, state => states.push(state),
  );
  const [before, after] = states;
  expect(after!.visibleText).toBe(before!.visibleText);
  expect(after!.fullHtml).toBe(before!.fullHtml);
  expect(after!.projection.rootId).toBe(before!.projection.rootId);
  const completion = (state: Snapshot) => ({ ...state, running: false,
    currentText: state.visibleText, currentHtml: state.fullHtml });
  const tracker = new ChatGptCompletionTracker();
  expect(tracker.update(completion(before!), 1_000).status).toBe("waiting");
  expect(tracker.update(completion(before!), 2_899).status).toBe("waiting");
  expect(tracker.update(completion(after!), 2_900).status).toBe("waiting");
  expect(tracker.update(completion(after!), 3_000).status).toBe("waiting");
  expect(tracker.update(completion(after!), 4_899).status).toBe("waiting");
  expect(tracker.update(completion(after!), 4_900).status).toBe("complete");
});

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

test("captured power UI excludes the user footer during streaming and completes the assistant answer", async () => {
  // Captured from the same live DEV turn on 2026-09-25. The user already has Copy/Share
  // controls while the assistant streams; both live under one data-turn-key.
  const streaming = await snapshot(powerStreamingHtml);
  expect(streaming.visibleText).toContain("How a Rainbow Begins");
  expect(streaming.visibleText).not.toContain("No tools or apps");
  expect(streaming.completionActionVisible).toBeFalse();
  const complete = await snapshot(powerCompleteHtml);
  expect(complete.visibleText).toEndWith("STREAM_END_927");
  expect(complete.completionActionVisible).toBeTrue();
  const buffer = new ChatGptMarkdownBuffer();
  buffer.observe(complete.markdownSegments, 0);
  const markdown = buffer.finish().markdown;
  expect(markdown).toContain("## How a Rainbow Begins");
  expect(markdown).toContain("1. Sunlight enters the droplet and refracts.");
  expect(markdown).toEndWith("STREAM\\_END\\_927");
  const translated = await snapshot(powerCompleteHtml.replaceAll('aria-label="Copy"', 'aria-label="복사"'));
  expect(translated.completionActionVisible).toBeTrue();
  const noAssistant = await snapshot(powerCompleteHtml.replaceAll('data-conversation-role="assistant"', 'data-conversation-role="user"'));
  expect(noAssistant.visibleText).toBe("");
  expect(noAssistant.completionActionVisible).toBeFalse();
  const userMarkdown = await snapshot(powerCompleteHtml.replace('data-user-message-bubble="true">',
    'data-user-message-bubble="true"><div class="markdown">USER CONTENT</div>'));
  expect(userMarkdown.visibleText).toBe(complete.visibleText);
});

test("captured power response keeps its Markdown ledger through final rendering", async () => {
  const streaming = await snapshot(powerStreamingHtml);
  const complete = await snapshot(powerCompleteHtml);
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  buffer.observe(streaming.markdownSegments, 0);
  buffer.observe(complete.markdownSegments, 1000);
  expect(buffer.currentSnapshotIsConsistent()).toBeTrue();
  expect(buffer.finish().markdown).toEndWith("STREAM\\_END\\_927");
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
