import type { Locator } from "playwright-core";
import { insertChatGptPromptText } from "../../src/adapters/chatgpt-web/prompt-insertion";
import { reanchorChatGptComposerCaret, chatGptPromptAttachmentMismatch } from "../../src/adapters/chatgpt-web/prompt-caret";
import { readChatGptPromptText, chatGptPromptTextEquivalent } from "../../src/adapters/chatgpt-web/prompt-text";
import type { ChatGptPromptOperation } from "../../src/adapters/chatgpt-web/prompt-operation";
import type { ChatGptPromptInsertionOptions } from "../../src/adapters/chatgpt-web/prompt-insertion-plan";
import type { ChatGptPromptInsertionSnapshot } from "../../src/adapters/chatgpt-web/prompt-insertion-metrics";

/** Only the external editor/DOM boundary is faked. Splitting, acceptance, readback,
 * deadlines, retries and caret evidence all execute their production implementations. */
export function literalPasteComposer(options: {
  initialText?: string;
  connector?: boolean;
  acceptPaste?: boolean;
  requirePlainPaste?: boolean;
  platform?: NodeJS.Platform;
  onPaste?(value: string, index: number): void;
  onFocus?(): void;
  afterEvaluate?(input: unknown): Promise<void> | void;
} = {}) {
  const { createDocument } = require("@mixmark-io/domino") as { createDocument(html: string): Document };
  const document = createDocument('<div id="composer" contenteditable="true"><p></p></div><button id="outside"></button>');
  let element = document.getElementById("composer")!;
  let active: Element = element;
  let anchor: Node = element.firstChild!;
  let anchorOffset = 0;
  let focus: Node = anchor;
  let collapsed = true;
  const pastes: string[] = [];
  const evaluations: unknown[] = [];
  const calls: string[] = [];
  const verified: string[] = [];
  const snapshots: ChatGptPromptInsertionSnapshot[] = [];
  const events: Array<{ type: string; key?: string; code?: string;
    ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; plainPaste: boolean }> = [];
  let plainPaste = false;
  let acquisitions = 0;
  let reanchors = 0;
  const selection = {
    get isCollapsed() { return collapsed; },
    get anchorNode() { return anchor; },
    get focusNode() { return focus; },
    get anchorOffset() { return anchorOffset; },
    rangeCount: 1,
    removeAllRanges() {},
    addRange(range: Range) {
      anchor = focus = range.startContainer;
      anchorOffset = range.startOffset;
      collapsed = true;
    },
  };
  const view = { getSelection: () => selection };
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
  Object.defineProperty(document, "defaultView", { configurable: true, value: view });

  // Domino has no browser Range implementation. These are only DOM selection primitives.
  document.createRange = () => {
    let startNode: Node = element;
    let startOffset = 0;
    return {
      setStart(node: Node, offset: number) { startNode = node; startOffset = offset; },
      setEnd() {},
      collapse() {},
      get startContainer() { return startNode; },
      get startOffset() { return startOffset; },
      cloneContents() {
        const fragment = document.createDocumentFragment();
        if (startNode.nodeType === 3) {
          fragment.appendChild(document.createTextNode((startNode.textContent ?? "").slice(startOffset)));
          for (let next = startNode.nextSibling; next; next = next.nextSibling) fragment.appendChild(next.cloneNode(true));
        } else {
          for (const child of Array.from(startNode.childNodes).slice(startOffset)) fragment.appendChild(child.cloneNode(true));
        }
        for (let parent = startNode.parentNode; parent && parent !== element; parent = parent.parentNode) {
          for (let next = parent.nextSibling; next; next = next.nextSibling) fragment.appendChild(next.cloneNode(true));
        }
        return fragment;
      },
    } as unknown as Range;
  };

  class DataTransferBoundary {
    private data = new Map<string, string>();
    setData(type: string, value: string) { this.data.set(type, value); }
    getData(type: string) { return this.data.get(type) ?? ""; }
    get types() { return [...this.data.keys()]; }
  }
  function ClipboardEventBoundary(type: string, init: ClipboardEventInit): Event {
    const event = document.createEvent("Event");
    event.initEvent(type, init.bubbles ?? false, init.cancelable ?? false);
    Object.defineProperty(event, "clipboardData", { value: init.clipboardData });
    return event;
  }
  function KeyboardEventBoundary(type: string, init: KeyboardEventInit): Event {
    const event = document.createEvent("Event");
    event.initEvent(type, init.bubbles ?? false, init.cancelable ?? false);
    for (const [key, value] of Object.entries({ key: init.key ?? "", code: init.code ?? "",
      ctrlKey: init.ctrlKey ?? false, metaKey: init.metaKey ?? false, shiftKey: init.shiftKey ?? false })) {
      Object.defineProperty(event, key, { value });
    }
    return event;
  }

  const moveCaretToEnd = () => {
    anchor = focus = element.firstChild!;
    anchorOffset = anchor.childNodes.length;
    collapsed = true;
  };
  const setText = (value: string) => {
    const paragraph = element.firstChild!;
    while (paragraph.lastChild) paragraph.removeChild(paragraph.lastChild);
    if (options.connector) {
      const pill = document.createElement("span");
      pill.setAttribute("data-id", "plugin:test");
      pill.setAttribute("data-keyword", "Codex Native2");
      pill.setAttribute("contenteditable", "false");
      pill.textContent = "Codex Native2";
      paragraph.appendChild(pill);
    }
    paragraph.appendChild(document.createTextNode(value));
    moveCaretToEnd();
  };
  const installEditorHandlers = () => {
    element.addEventListener("keydown", event => {
      const key = event as KeyboardEvent;
      const mac = (options.platform ?? process.platform) === "darwin";
      if (key.key.toUpperCase() === "V" && key.code === "KeyV" && key.shiftKey
        && (mac ? key.metaKey && !key.ctrlKey : key.ctrlKey && !key.metaKey)) plainPaste = true;
      events.push({ type: event.type, key: key.key, code: key.code,
        ctrlKey: key.ctrlKey, metaKey: key.metaKey, shiftKey: key.shiftKey, plainPaste });
    });
    element.addEventListener("keyup", event => {
      const key = event as KeyboardEvent;
      if (key.key === "Shift" && key.code === "ShiftLeft" && !key.shiftKey) plainPaste = false;
      events.push({ type: event.type, key: key.key, code: key.code,
        ctrlKey: key.ctrlKey, metaKey: key.metaKey, shiftKey: key.shiftKey, plainPaste });
    });
    element.addEventListener("paste", event => {
      const data = (event as ClipboardEvent).clipboardData!;
      if (JSON.stringify(data.types) !== '["text/plain"]') throw new Error("Unexpected non-literal clipboard payload");
      const value = data.getData("text/plain");
      pastes.push(value);
      calls.push("paste");
      events.push({ type: event.type, plainPaste });
      if (options.acceptPaste === false || (options.requirePlainPaste && !plainPaste)) return;
      event.preventDefault();
      const span = document.createElement("span");
      // Model the public editor representation: LF is inline BR; everything else is text.
      value.split("\n").forEach((line, index) => {
        if (index) span.appendChild(document.createElement("br"));
        span.appendChild(document.createTextNode(line));
      });
      if (anchor.nodeType === 3) {
        const text = anchor as Text;
        const suffix = text.splitText(anchorOffset);
        suffix.parentNode!.insertBefore(span, suffix);
      } else anchor.insertBefore(span, anchor.childNodes[anchorOffset] ?? null);
      anchor = focus = span;
      anchorOffset = span.childNodes.length;
      options.onPaste?.(value, pastes.length);
    });
  };
  installEditorHandlers();
  setText(options.initialText ?? "");
  const composer = {
    focus: async () => { calls.push("focus"); options.onFocus?.(); },
    evaluate: async (callback: (node: HTMLElement, input: unknown) => unknown, input: unknown) => {
      evaluations.push(input);
      const result = await callback(element, input);
      await options.afterEvaluate?.(input);
      return result;
    },
  } as unknown as Locator;

  async function withGlobals<T>(action: () => Promise<T>): Promise<T> {
    const values = { document, window: view, Node: require("@mixmark-io/domino").impl.Node,
      Element: require("@mixmark-io/domino").impl.Element, DataTransfer: DataTransferBoundary,
      ClipboardEvent: ClipboardEventBoundary, KeyboardEvent: KeyboardEventBoundary,
      requestAnimationFrame: (done: () => void) => setTimeout(done, 0),
      cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id) };
    const descriptors = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    Object.assign(globalThis, values);
    try { return await action(); }
    finally {
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  }
  const read = () => readChatGptPromptText(element, { preserveLeading: true });
  const verify = async (expected: string) => {
    calls.push("verify");
    verified.push(expected);
    const observed = read();
    if (!chatGptPromptTextEquivalent(expected, observed)) {
      throw chatGptPromptAttachmentMismatch("Fixture prompt integrity mismatch", expected, observed);
    }
  };
  const reanchor = async () => {
    calls.push("reanchor");
    reanchors += 1;
    if (!await reanchorChatGptComposerCaret(composer)) throw new Error("Fixture caret could not reanchor");
  };
  return {
    composer, document, get element() { return element; }, pastes, evaluations, calls, verified, snapshots, events,
    get plainPaste() { return plainPaste; }, get modifierCleared() { return !plainPaste; },
    read, verify, reanchor, withGlobals, setText, moveCaretToEnd,
    get acquisitions() { return acquisitions; }, get reanchors() { return reanchors; },
    setSelection(state: { collapsed?: boolean; outside?: boolean; activeOutside?: boolean }) {
      collapsed = state.collapsed ?? true;
      if (state.outside) anchor = focus = document.getElementById("outside")!;
      active = state.activeOutside ? document.getElementById("outside")! : element;
    },
    remount(keepStaleSelection = false) {
      const replacement = element.cloneNode(true) as HTMLElement;
      element.parentNode!.replaceChild(replacement, element);
      element = replacement; active = element;
      installEditorHandlers();
      if (!keepStaleSelection) moveCaretToEnd();
    },
    run(text: string, args: {
      signal?: AbortSignal; options?: ChatGptPromptInsertionOptions; operation?: ChatGptPromptOperation;
      connectorSelected?: boolean; existingPrefix?: string;
      verify?(expected: string): Promise<void>; reanchor?(): Promise<void>;
    } = {}) {
      return withGlobals(() => insertChatGptPromptText(text, args.signal, {
        composer: async () => { calls.push("acquire"); acquisitions += 1; return composer; },
        verify: args.verify ?? verify, reanchor: args.reanchor ?? reanchor,
        connectorSelected: args.connectorSelected, existingPrefix: args.existingPrefix,
        onProgress: snapshot => snapshots.push(snapshot),
      }, args.options, args.operation));
    },
  };
}
