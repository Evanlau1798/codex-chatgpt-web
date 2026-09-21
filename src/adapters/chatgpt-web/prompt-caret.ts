import { ChatGptPromptOperation } from "./prompt-operation";
import { chatGptPromptMismatchDetails } from "./prompt-text";
import { chatGptNativeEditValue, type ChatGptPromptInsertionMetrics } from "./prompt-insertion-metrics";
import type { Locator } from "playwright-core";
import { chatGptWebSurfaceError, ChatGptPromptIntegrityMismatchError } from "./adapter-error";
import { CHATGPT_PROMPT_MARKDOWN_DELIMITERS as MARKDOWN_SHORTCUT_DELIMITERS } from "./prompt-insertion-plan";

export interface ChatGptCaretEvidence {
  collapsed: boolean;
  anchorInsideComposer: boolean;
  focusInsideComposer: boolean;
  trailingEditableText: string;
}

const ZERO_WIDTH_TEXT = /[\u200B\u200C\u200D\uFEFF]/g;
const RESTORATION_WHITESPACE = /[^\S\r\n\u2028\u2029]/u;
const MARKDOWN_RESTORATION_RANGE_CHARS = 8_192;
const MARKDOWN_RESTORATION_BATCH_SIZE = 128;
const STRUCTURED_MARKDOWN = /[\r\n\u2028\u2029]/u;

type ChatGptPromptBoundaryReplacement = { marker: string; value: string };
type MarkdownReplacement = ChatGptPromptBoundaryReplacement & { count: number };
export type ChatGptPromptMarkdownGuard = {
  text: string;
  replacements: MarkdownReplacement[];
  count: number;
};
type MarkdownRestorationStrategy = "exact" | "range";
type MarkdownRestorationEvidence = {
  ok: boolean;
  strategy: MarkdownRestorationStrategy;
  initialMarkers: number;
  remainingMarkers: number;
  batches: number;
};

const CHATGPT_COMPOSER_SELECT_ALL_KEY = process.platform === "darwin" ? "Meta+A" : "Control+A";

export function guardChatGptPromptMarkdown(text: string): ChatGptPromptMarkdownGuard | undefined {
  let guarded = text;
  let codePoint = 0xE000;
  const replacements: MarkdownReplacement[] = [];
  for (const value of MARKDOWN_SHORTCUT_DELIMITERS) {
    const count = text.length - text.replaceAll(value, "").length;
    if (count === 0) continue;
    let marker = String.fromCharCode(codePoint);
    while (text.includes(marker) || replacements.some(replacement => replacement.marker === marker)) {
      codePoint += 1;
      if (codePoint > 0xF8FF) throw new Error("ChatGPT prompt has no available Markdown marker");
      marker = String.fromCharCode(codePoint);
    }
    codePoint += 1;
    guarded = guarded.replaceAll(value, marker);
    replacements.push({ marker, value, count });
  }
  return replacements.length === 0
    ? undefined
    : { text: guarded, replacements, count: replacements.reduce((sum, replacement) => sum + replacement.count, 0) };
}

async function restoreChatGptPromptMarkdownRanges(
  composer: Locator,
  replacements: MarkdownReplacement[],
  count: number,
  abortSignal?: AbortSignal,
  metrics?: ChatGptPromptInsertionMetrics,
  operation?: ChatGptPromptOperation,
): Promise<MarkdownRestorationEvidence> {
  const op = operation ?? new ChatGptPromptOperation(abortSignal);
  op.check();
  let remaining = count;
  let batches = 0;
  const markers = replacements.map(replacement => replacement.marker);
  while (remaining > 0) {
    if (abortSignal?.aborted) throw abortSignal.reason ?? new DOMException("Prompt attachment aborted", "AbortError");
    const editResult = await op.mutate(options => {
      metrics?.restorationBatch();
      metrics?.editStarted();
      return composer.evaluate((element, input) => {
      let attempts = 0; let accepted = 0;
      const result = <T>(result: T) => ({ result, attempts, accepted });
      const edit = (command: string, value: string) => {
        attempts += 1; const ok = document.execCommand(command, false, value);
        if (ok) accepted += 1; return ok;
      };
      const ignoredSelector = '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target]';
      const values = new Map(input.replacements.map(replacement => [replacement.marker, replacement.value]));
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let candidate: { node: Text; right: number } | undefined;
      for (let current = walker.nextNode(); current; current = walker.nextNode()) {
        const node = current as Text;
        if (node.parentElement?.closest(ignoredSelector)) continue;
        for (let offset = node.data.length - 1; offset >= 0; offset -= 1) {
          if (values.has(node.data[offset]!)) {
            candidate = { node, right: offset };
            break;
          }
        }
      }
      const selection = window.getSelection();
      if (!candidate || !selection) return result(0);
      let end = candidate.right + 1;
      while (end < candidate.node.data.length && /\s/u.test(candidate.node.data[end] ?? "")) end += 1;
      if (end < candidate.node.data.length) {
        const next = candidate.node.data.charCodeAt(end);
        const afterNext = candidate.node.data.charCodeAt(end + 1);
        end += next >= 0xD800 && next <= 0xDBFF && afterNext >= 0xDC00 && afterNext <= 0xDFFF ? 2 : 1;
      }
      const startLimit = Math.max(0, end - input.maxChars);
      let start = candidate.right;
      let markerCount = 0;
      for (let offset = startLimit; offset <= candidate.right; offset += 1) {
        if (!values.has(candidate.node.data[offset]!)) continue;
        start = Math.min(start, offset);
        markerCount += 1;
      }
      const restoredText = Array.from(candidate.node.data.slice(start, end), value => values.get(value) ?? value).join("");
      const range = document.createRange();
      range.setStart(candidate.node, start);
      range.setEnd(candidate.node, end);
      selection.removeAllRanges();
      selection.addRange(range);
      return result(edit("insertText", restoredText) ? markerCount : 0);
    }, { replacements, maxChars: MARKDOWN_RESTORATION_RANGE_CHARS }, options);
    });
    const restored = chatGptNativeEditValue(editResult, metrics);
    batches += 1;
    if (!Number.isSafeInteger(restored) || restored <= 0 || restored > remaining) {
      return { ok: false, strategy: "range", initialMarkers: count, remainingMarkers: remaining, batches };
    }
    await op.poll(0);
    const observedRemaining = await op.read(options => composer.evaluate((element, values) => {
      const ignoredSelector = '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target]';
      const markerSet = new Set(values);
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let found = 0;
      for (let current = walker.nextNode(); current; current = walker.nextNode()) {
        const node = current as Text;
        if (node.parentElement?.closest(ignoredSelector)) continue;
        for (const value of node.data) if (markerSet.has(value)) found += 1;
      }
      return found;
    }, markers, options));
    if (!Number.isSafeInteger(observedRemaining)
      || observedRemaining < 0
      || remaining - observedRemaining !== restored) {
      return { ok: false, strategy: "range", initialMarkers: count, remainingMarkers: observedRemaining, batches };
    }
    remaining = observedRemaining;
    metrics?.markers(remaining);
  }
  return { ok: true, strategy: "range", initialMarkers: count, remainingMarkers: 0, batches };
}

async function restoreChatGptPromptMarkdownExactly(
  composer: Locator,
  replacements: MarkdownReplacement[],
  count: number,
  abortSignal?: AbortSignal,
  metrics?: ChatGptPromptInsertionMetrics,
  operation?: ChatGptPromptOperation,
): Promise<MarkdownRestorationEvidence> {
  const op = operation ?? new ChatGptPromptOperation(abortSignal);
  op.check();
  const markers = replacements.map(replacement => replacement.marker);
  const countMarkers = () => op.read(options => composer.evaluate((element, values) => {
    const ignoredSelector = '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target]';
    const markerSet = new Set(values);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let found = 0;
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      const node = current as Text;
      if (node.parentElement?.closest(ignoredSelector)) continue;
      for (const value of node.data) if (markerSet.has(value)) found += 1;
    }
    return found;
  }, markers, options));
  let remaining = count;
  let batches = 0;
  while (remaining > 0) {
    if (abortSignal?.aborted) throw abortSignal.reason ?? new DOMException("Prompt attachment aborted", "AbortError");
    await op.mutate(options => composer.focus(options));
    const editResult = await op.mutate(options => {
      metrics?.restorationBatch();
      metrics?.editStarted();
      return composer.evaluate(async (element, input) => {
      let attempts = 0; let accepted = 0;
      const result = <T>(result: T) => ({ result, attempts, accepted });
      const edit = (command: string, value: string) => {
        attempts += 1; const ok = document.execCommand(command, false, value);
        if (ok) accepted += 1; return ok;
      };
      const ignoredSelector = '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target]';
      const selection = window.getSelection();
      if (!selection) return result(0);
      const values = new Map(input.replacements.map(replacement => [replacement.marker, replacement.value]));
      const rightmostText = (node: Node): Text | undefined => {
        if (node.nodeType === 1 && (node as Element).matches(ignoredSelector)) return undefined;
        if (node.nodeType === 3) {
          const text = node as Text;
          return text.parentElement?.closest(ignoredSelector) ? undefined : text;
        }
        for (let child = node.lastChild; child; child = child.previousSibling) {
          const found = rightmostText(child);
          if (found) return found;
        }
        return undefined;
      };
      const previousText = (node: Node): Text | undefined => {
        for (let current: Node | null = node; current && current !== element; current = current.parentNode) {
          for (let sibling = current.previousSibling; sibling; sibling = sibling.previousSibling) {
            const found = rightmostText(sibling);
            if (found) return found;
          }
        }
        return undefined;
      };
      let position = rightmostText(element);
      let before = position?.data.length ?? 0;
      let edited = 0;
      while (position && edited < input.batchSize) {
        let match: { offset: number; value: string } | undefined;
        for (const replacement of input.replacements) {
          const offset = position.data.lastIndexOf(replacement.marker, before - 1);
          if (offset >= 0 && (!match || offset > match.offset)) match = { offset, value: replacement.value };
        }
        if (!match) {
          position = previousText(position);
          before = position?.data.length ?? 0;
          continue;
        }
        const range = document.createRange();
        range.setStart(position, match.offset);
        range.setEnd(position, match.offset + 1);
        selection.removeAllRanges();
        selection.addRange(range);
        if (!edit("insertText", match.value)) return result(-1);
        edited += 1;
        before = match.offset;
        await Promise.resolve();
        if (!element.contains(position)) break;
      }
      return result(edited);
    }, { replacements, batchSize: MARKDOWN_RESTORATION_BATCH_SIZE }, options);
    });
    const restored = chatGptNativeEditValue(editResult, metrics);
    batches += 1;
    if (abortSignal?.aborted) throw abortSignal.reason ?? new DOMException("Prompt attachment aborted", "AbortError");
    if (!Number.isSafeInteger(restored) || restored <= 0 || restored > remaining) {
      return { ok: false, strategy: "exact", initialMarkers: count, remainingMarkers: remaining, batches };
    }
    await op.poll(0);
    if (abortSignal?.aborted) throw abortSignal.reason ?? new DOMException("Prompt attachment aborted", "AbortError");
    const observedRemaining = await countMarkers();
    if (!Number.isSafeInteger(observedRemaining)
      || observedRemaining < 0
      || remaining - observedRemaining !== restored) {
      return { ok: false, strategy: "exact", initialMarkers: count, remainingMarkers: observedRemaining, batches };
    }
    remaining = observedRemaining;
    metrics?.markers(remaining);
  }
  return { ok: true, strategy: "exact", initialMarkers: count, remainingMarkers: 0, batches };
}

export async function restoreChatGptPromptMarkdown(
  composer: Locator,
  text: string,
  guarded: ChatGptPromptMarkdownGuard,
  abortSignal?: AbortSignal,
  metrics?: ChatGptPromptInsertionMetrics,
  operation?: ChatGptPromptOperation,
): Promise<void> {
  const restoration = STRUCTURED_MARKDOWN.test(text)
    ? await restoreChatGptPromptMarkdownExactly(composer, guarded.replacements, guarded.count, abortSignal, metrics, operation)
    : await restoreChatGptPromptMarkdownRanges(composer, guarded.replacements, guarded.count, abortSignal, metrics, operation);
  if (!restoration.ok) throw chatGptWebSurfaceError(
    `ChatGPT composer could not preserve literal Markdown in a bounded edit (strategy=${restoration.strategy}, initialMarkers=${restoration.initialMarkers}, remainingMarkers=${restoration.remainingMarkers}, batches=${restoration.batches})`,
    false,
  );
}

export async function insertChatGptComposerGuardedText(
  composer: Locator,
  text: string,
  abortSignal?: AbortSignal,
  plainTextBlocks = false,
  metrics?: ChatGptPromptInsertionMetrics,
  operation?: ChatGptPromptOperation,
): Promise<void> {
  const op = operation ?? new ChatGptPromptOperation(abortSignal);
  op.check();
  await op.mutate(options => composer.focus(options));
  const editResult = await op.mutate(options => {
    metrics?.editStarted();
    return composer.evaluate((element, input) => {
    let attempts = 0; let accepted = 0;
    const result = <T>(result: T) => ({ result, attempts, accepted });
    const edit = (command: string, value: string) => {
      attempts += 1; const ok = document.execCommand(command, false, value);
      if (ok) accepted += 1; return ok;
    };
    const value = typeof input === "string" ? input : input.text;
    const selection = window.getSelection();
    if (
      document.activeElement !== element
      || !selection
      || !selection.isCollapsed
      || !selection.anchorNode
      || !selection.focusNode
      || !element.contains(selection.anchorNode)
      || !element.contains(selection.focusNode)
    ) {
      return result(false);
    }
    if (typeof input !== "string") {
      // A single escaped text fragment avoids insertText's incremental paragraph creation.
      const html = value.split("\n").map(line => (
        `<div>${line.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;") || "<br>"}</div>`
      )).join("");
      return result(edit("insertHTML", html));
    }
    return result(edit("insertText", value));
  }, plainTextBlocks ? { text } : text, options);
  });
  const inserted = chatGptNativeEditValue(editResult, metrics);
  if (!inserted) throw chatGptWebSurfaceError("ChatGPT composer rejected the bounded plain-text edit", false);
}

export async function insertChatGptComposerPlainText(
  composer: Locator,
  text: string,
  abortSignal?: AbortSignal,
  operation?: ChatGptPromptOperation,
): Promise<void> {
  const op = operation ?? new ChatGptPromptOperation(abortSignal);
  op.check();
  const guarded = guardChatGptPromptMarkdown(text);
  await insertChatGptComposerGuardedText(composer, guarded?.text ?? text, abortSignal, false, undefined, op);
  if (guarded) {
    await restoreChatGptPromptMarkdown(composer, text, guarded, abortSignal, undefined, op);
  }
}

export async function clearChatGptComposerInput(
  composer: Locator,
  abortSignal?: AbortSignal,
  operation?: ChatGptPromptOperation,
): Promise<void> {
  const op = (operation ?? new ChatGptPromptOperation(abortSignal)).budget(5_000);
  await op.mutate(options => composer.fill("", options));
  const hasText = await op.read(options => composer.evaluate(
    element => (element.textContent?.trim().length ?? 0) > 0,
    undefined,
    options,
  ));
  if (!hasText) return;
  await op.mutate(options => composer.focus(options));
  await op.mutate(options => composer.press(CHATGPT_COMPOSER_SELECT_ALL_KEY, options));
  await op.mutate(options => composer.press("Backspace", options));
}

export function guardChatGptPromptChunkBoundary(
  text: string,
  chunk: string,
  offset: number,
): { text: string; replacement: ChatGptPromptBoundaryReplacement } | undefined {
  if (offset <= 0 || !RESTORATION_WHITESPACE.test(chunk[0] ?? "")) return undefined;
  let codePoint = 0xF8FF;
  while (codePoint >= 0xE000 && text.includes(String.fromCharCode(codePoint))) codePoint -= 1;
  if (codePoint < 0xE000) throw new Error("ChatGPT prompt has no available chunk-boundary marker");
  const marker = String.fromCharCode(codePoint);
  return {
    text: `${marker}${chunk.slice(1)}`,
    replacement: { marker, value: chunk[0]! },
  };
}

export async function restoreChatGptPromptChunkBoundary(
  composer: Locator,
  replacement: ChatGptPromptBoundaryReplacement,
  abortSignal?: AbortSignal,
  metrics?: ChatGptPromptInsertionMetrics,
  operation?: ChatGptPromptOperation,
): Promise<boolean> {
  const op = operation ?? new ChatGptPromptOperation(abortSignal);
  op.check();
  await op.mutate(options => composer.focus(options));
  const editResult = await op.mutate(options => {
    metrics?.editStarted();
    return composer.evaluate((element, input) => {
    let attempts = 0; let accepted = 0;
    const result = <T>(result: T) => ({ result, attempts, accepted });
    const edit = (command: string, value: string) => {
      attempts += 1; const ok = document.execCommand(command, false, value);
      if (ok) accepted += 1; return ok;
    };
    const ignoredSelector = '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target]';
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let match: { node: Text; offset: number } | undefined;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      if (text.parentElement?.closest(ignoredSelector)) continue;
      const offset = text.data.indexOf(input.marker);
      if (offset < 0) continue;
      if (match || text.data.indexOf(input.marker, offset + input.marker.length) >= 0) return result(false);
      match = { node: text, offset };
    }
    const selection = window.getSelection();
    if (!match || !selection) return result(false);
    const range = document.createRange();
    range.setStart(match.node, match.offset);
    range.setEnd(match.node, match.offset + input.marker.length);
    selection.removeAllRanges();
    selection.addRange(range);
    return result(edit("insertText", input.value));
  }, replacement, options);
  });
  const restored = chatGptNativeEditValue(editResult, metrics);
  if (!restored) return false;
  await op.poll(0);
  if (abortSignal?.aborted) throw abortSignal.reason ?? new DOMException("Prompt attachment aborted", "AbortError");
  return await op.read(options => composer.evaluate((element, marker) => {
    const ignoredSelector = '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target]';
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      if (!text.parentElement?.closest(ignoredSelector) && text.data.includes(marker)) return false;
    }
    return true;
  }, replacement.marker, options));
}

export function chatGptPromptAttachmentMismatch(
  message: string,
  expected: string,
  observed: string,
  equivalentPrefix?: number,
): Error {
  const details = chatGptPromptMismatchDetails(expected, observed);
  // Keep the existing caller's equivalent-prefix diagnostic without exporting reversible text.
  if (equivalentPrefix !== undefined) details.commonPrefixChars = equivalentPrefix;
  return new ChatGptPromptIntegrityMismatchError(
    `${message} (${Object.entries(details).map(([key, value]) => `${key}=${value}`).join(", ")})`,
  );
}

export function chatGptCaretAtLogicalEnd(evidence: ChatGptCaretEvidence): boolean {
  return evidence.collapsed
    && evidence.anchorInsideComposer
    && evidence.focusInsideComposer
    && evidence.trailingEditableText.replace(ZERO_WIDTH_TEXT, "").length === 0;
}

export async function reanchorChatGptComposerCaret(
  composer: Locator,
  attempts = 2,
  abortSignal?: AbortSignal,
  operation?: ChatGptPromptOperation,
): Promise<boolean> {
  const op = (operation ?? new ChatGptPromptOperation(abortSignal)).budget(20_000);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await op.mutate(options => composer.focus(options));
    const evidence = await op.mutate(options => composer.evaluate(async element => {
      const ignoredSelector = '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target]';
      const editableRootNodes = [...element.childNodes].filter(node => (
        node.nodeType === Node.TEXT_NODE
          ? (node.textContent ?? "").length > 0
          : node instanceof Element && !node.matches(ignoredSelector)
      ));
      const finalRootNode = editableRootNodes[editableRootNodes.length - 1];
      if (!finalRootNode) {
        return {
          collapsed: false,
          anchorInsideComposer: false,
          focusInsideComposer: false,
          trailingEditableText: "missing-boundary",
        };
      }

      const textNodes: Text[] = [];
      const collectTextNodes = (node: Node): void => {
        if (node instanceof Element && node.matches(ignoredSelector)) return;
        if (node.nodeType === Node.TEXT_NODE) {
          if ((node.textContent ?? "").length > 0) textNodes.push(node as Text);
          return;
        }
        for (const child of node.childNodes) collectTextNodes(child);
      };
      collectTextNodes(finalRootNode);
      const lastTextNode = textNodes[textNodes.length - 1];
      const cursorTarget = finalRootNode instanceof Element
        ? finalRootNode.querySelector("[data-inline-selection-pill-cursor-target]")
        : null;

      let targetNode: Node;
      let targetOffset: number;
      const cursorFollowsText = lastTextNode && cursorTarget
        ? (lastTextNode.compareDocumentPosition(cursorTarget) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        : false;
      if (cursorTarget?.parentNode && (!lastTextNode || cursorFollowsText)) {
        targetNode = cursorTarget.parentNode;
        targetOffset = [...targetNode.childNodes].indexOf(cursorTarget);
      } else if (lastTextNode) {
        targetNode = lastTextNode;
        targetOffset = lastTextNode.data.length;
      } else if (finalRootNode instanceof Element && !["AREA", "BR", "HR", "IMG", "INPUT"].includes(finalRootNode.tagName)) {
        targetNode = finalRootNode;
        targetOffset = finalRootNode.childNodes.length;
      } else {
        return {
          collapsed: false,
          anchorInsideComposer: false,
          focusInsideComposer: false,
          trailingEditableText: "missing-target",
        };
      }

      const selection = window.getSelection();
      if (!selection) {
        return {
          collapsed: false,
          anchorInsideComposer: false,
          focusInsideComposer: false,
          trailingEditableText: "missing-selection",
        };
      }
      const range = document.createRange();
      range.setStart(targetNode, targetOffset);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);

      await new Promise<void>(resolveFrame => {
        // Hidden documents can suspend rAF. The timer only wakes the evidence read below.
        let frame = 0;
        const finish = () => { clearTimeout(timer); cancelAnimationFrame(frame); resolveFrame(); };
        const timer = setTimeout(finish, 100);
        frame = requestAnimationFrame(finish);
      });
      const anchorNode = selection.anchorNode;
      const focusNode = selection.focusNode;
      const anchorInsideComposer = anchorNode !== null && element.contains(anchorNode);
      const focusInsideComposer = focusNode !== null && element.contains(focusNode);
      let trailingEditableText = "selection-outside-composer";
      if (selection.isCollapsed && anchorInsideComposer && focusInsideComposer && selection.rangeCount === 1) {
        const trailing = document.createRange();
        trailing.setStart(anchorNode!, selection.anchorOffset);
        trailing.setEnd(element, element.childNodes.length);
        const remainder = trailing.cloneContents();
        remainder.querySelectorAll(ignoredSelector).forEach(part => part.remove());
        trailingEditableText = remainder.textContent ?? "";
      }
      return {
        collapsed: selection.isCollapsed,
        anchorInsideComposer,
        focusInsideComposer,
        trailingEditableText,
      };
    }, undefined, options));
    if (chatGptCaretAtLogicalEnd(evidence)) return true;
  }
  return false;
}
