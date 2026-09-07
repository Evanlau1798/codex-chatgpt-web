import type { Locator } from "playwright-core";
import { chatGptWebSurfaceError } from "./adapter-error";

export interface ChatGptCaretEvidence {
  collapsed: boolean;
  anchorInsideComposer: boolean;
  focusInsideComposer: boolean;
  trailingEditableText: string;
}

const ZERO_WIDTH_TEXT = /[\u200B\u200C\u200D\u2060\uFEFF]/g;
const RESTORATION_WHITESPACE = /\s/u;

function codePointWindow(value: string, offset: number): string {
  return Array.from(value.slice(offset), char => (
    `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`
  )).slice(0, 6).join(",");
}

type ChatGptPromptBoundaryReplacement = { marker: string; value: string };

const CHATGPT_COMPOSER_SELECT_ALL_KEY = process.platform === "darwin" ? "Meta+A" : "Control+A";

export async function insertChatGptComposerPlainText(
  composer: Locator,
  text: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  const options = { signal: abortSignal, timeout: 20_000 };
  await composer.focus(options);
  const inserted = await composer.evaluate((element, value) => {
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
      return false;
    }
    return document.execCommand("insertText", false, value);
  }, text, options);
  if (!inserted) {
    throw chatGptWebSurfaceError("ChatGPT composer rejected the bounded plain-text edit", false);
  }
}

export async function clearChatGptComposerInput(
  composer: Locator,
  abortSignal?: AbortSignal,
): Promise<void> {
  const options = { signal: abortSignal, timeout: 5_000 };
  await composer.fill("", options);
  const hasText = await composer.evaluate(
    element => (element.textContent?.trim().length ?? 0) > 0,
    undefined,
    options,
  );
  if (!hasText) return;
  await composer.focus(options);
  await composer.press(CHATGPT_COMPOSER_SELECT_ALL_KEY, options);
  await composer.press("Backspace", options);
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
): Promise<boolean> {
  const options = { signal: abortSignal, timeout: 20_000 };
  await composer.focus(options);
  const restored = await composer.evaluate((element, input) => {
    const ignoredSelector = '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target]';
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let match: { node: Text; offset: number } | undefined;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      if (text.parentElement?.closest(ignoredSelector)) continue;
      const offset = text.data.indexOf(input.marker);
      if (offset < 0) continue;
      if (match || text.data.indexOf(input.marker, offset + input.marker.length) >= 0) return false;
      match = { node: text, offset };
    }
    const selection = window.getSelection();
    if (!match || !selection) return false;
    const range = document.createRange();
    range.setStart(match.node, match.offset);
    range.setEnd(match.node, match.offset + input.marker.length);
    selection.removeAllRanges();
    selection.addRange(range);
    return document.execCommand("insertText", false, input.value);
  }, replacement, options);
  if (!restored) return false;
  await new Promise(resolve => setTimeout(resolve, 0));
  if (abortSignal?.aborted) throw abortSignal.reason ?? new DOMException("Prompt attachment aborted", "AbortError");
  return await composer.evaluate((element, marker) => {
    const ignoredSelector = '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target]';
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      if (!text.parentElement?.closest(ignoredSelector) && text.data.includes(marker)) return false;
    }
    return true;
  }, replacement.marker, options);
}

export function chatGptPromptAttachmentMismatch(
  message: string,
  expected: string,
  observed: string,
  equivalentPrefix?: number,
): Error {
  let commonPrefix = equivalentPrefix ?? 0;
  if (equivalentPrefix === undefined) {
    while (commonPrefix < expected.length && expected[commonPrefix] === observed[commonPrefix]) {
      commonPrefix += 1;
    }
  }
  return chatGptWebSurfaceError(
    `${message} (expectedChars=${expected.length}, actualChars=${observed.length}, commonPrefixChars=${commonPrefix}, expectedCodePoints=${codePointWindow(expected, commonPrefix)}, actualCodePoints=${codePointWindow(observed, commonPrefix)})`,
    false,
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
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await composer.focus();
    const evidence = await composer.evaluate(async element => {
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

      await new Promise<void>(resolveFrame => requestAnimationFrame(() => resolveFrame()));
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
    }, undefined, { timeout: 20_000 });
    if (chatGptCaretAtLogicalEnd(evidence)) return true;
  }
  return false;
}
