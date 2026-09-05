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

const MARKDOWN_SHORTCUT_DELIMITERS = ["`", "*", "_", "~", "=", "[", ")"] as const;

type MarkdownReplacement = { marker: string; value: string; count: number };

const CHATGPT_COMPOSER_SELECT_ALL_KEY = process.platform === "darwin" ? "Meta+A" : "Control+A";

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
): { text: string; replacement: MarkdownReplacement } | undefined {
  if (offset <= 0 || !RESTORATION_WHITESPACE.test(chunk[0] ?? "")) return undefined;
  let codePoint = 0xF8FF;
  while (codePoint >= 0xE000 && text.includes(String.fromCharCode(codePoint))) codePoint -= 1;
  if (codePoint < 0xE000) throw new Error("ChatGPT prompt has no available chunk-boundary marker");
  const marker = String.fromCharCode(codePoint);
  return {
    text: `${marker}${chunk.slice(1)}`,
    replacement: { marker, value: chunk[0]!, count: 1 },
  };
}

export function previousChatGptPromptMarkdownMarker(
  text: string,
  before: number,
  replacements: MarkdownReplacement[],
): { offset: number; value: string } | undefined {
  let match: { offset: number; value: string } | undefined;
  for (const replacement of replacements) {
    const offset = text.lastIndexOf(replacement.marker, before - 1);
    if (offset >= 0 && (!match || offset > match.offset)) match = { offset, value: replacement.value };
  }
  return match;
}

export function guardChatGptPromptMarkdown(text: string): {
  text: string;
  replacements: Array<{ marker: string; value: string; count: number }>;
  count: number;
} | undefined {
  let guarded = text;
  let codePoint = 0xE000;
  const replacements: Array<{ marker: string; value: string; count: number }> = [];
  for (const value of MARKDOWN_SHORTCUT_DELIMITERS) {
    const count = text.length - text.replaceAll(value, "").length;
    if (count === 0) continue;
    let marker = replacements.length === 0 ? "\u2060" : String.fromCharCode(codePoint++);
    while (text.includes(marker) || replacements.some(replacement => replacement.marker === marker)) {
      if (codePoint > 0xF8FF) throw new Error("ChatGPT prompt has no available Markdown marker");
      marker = String.fromCharCode(codePoint++);
    }
    guarded = guarded.replaceAll(value, marker);
    replacements.push({ marker, value, count });
  }
  if (replacements.length === 0) return undefined;
  return { text: guarded, replacements, count: replacements.reduce((sum, value) => sum + value.count, 0) };
}

export const CHATGPT_PROMPT_MARKDOWN_RESTORATION_BATCH_SIZE = 128;

export async function restoreChatGptPromptMarkdown(
  composer: Locator,
  replacements: MarkdownReplacement[],
  count: number,
  maxChars = 16_000,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new Error("ChatGPT Markdown restoration range must be a positive integer");
  }
  await composer.focus();
  let remaining = count;
  while (remaining > 0) {
    if (abortSignal?.aborted) throw abortSignal.reason ?? new DOMException("Prompt attachment aborted", "AbortError");
    const restored = await composer.evaluate(async (element, input) => {
      const ignoredSelector = '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target]';
      const selection = window.getSelection();
      if (!selection) return 0;
      const replacementsByMarker = new Map(input.replacements.map(value => [value.marker, value.value]));
      const rightmostText = (node: Node): Text | undefined => {
        if (node.nodeType === 1 && (node as Element).matches(ignoredSelector)) return undefined;
        if (node.nodeType === 3) {
          const text = node as Text;
          return text.parentElement?.closest(ignoredSelector) ? undefined : text;
        }
        for (let child = node.lastChild; child; child = child.previousSibling) {
          const text = rightmostText(child);
          if (text) return text;
        }
        return undefined;
      };
      const previousText = (node: Node): Text | undefined => {
        for (let current: Node | null = node; current && current !== element; current = current.parentNode) {
          for (let sibling = current.previousSibling; sibling; sibling = sibling.previousSibling) {
            const text = rightmostText(sibling);
            if (text) return text;
          }
        }
        return undefined;
      };
      let position = rightmostText(element);
      let before = position?.data.length ?? 0;
      let restored = 0;
      // Keep the serialized Playwright input stable; maxChars remains the
      // public mutation bound while each browser task performs at most 128 edits.
      while (position && restored < Math.min(input.maxChars, 128)) {
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
        if (!document.execCommand("insertText", false, match.value)) return -1;
        restored += 1;
        before = match.offset;
        await Promise.resolve();
        if (!element.contains(position)) break;
      }
      return restored;
    }, { replacements, maxChars }, { timeout: 20_000 });
    if (abortSignal?.aborted) throw abortSignal.reason ?? new DOMException("Prompt attachment aborted", "AbortError");
    if (!Number.isSafeInteger(restored) || restored <= 0 || restored > remaining) return false;
    remaining -= restored;
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  if (abortSignal?.aborted) throw abortSignal.reason ?? new DOMException("Prompt attachment aborted", "AbortError");
  return composer.evaluate((element, markers) => {
    const ignoredSelector = '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target]';
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      if (!text.parentElement?.closest(ignoredSelector) && markers.some(marker => text.data.includes(marker))) {
        return false;
      }
    }
    return true;
  }, replacements.map(replacement => replacement.marker), { timeout: 20_000 });
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
