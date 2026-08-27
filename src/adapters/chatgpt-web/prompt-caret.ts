import type { Locator } from "playwright-core";
import { chatGptWebSurfaceError } from "./adapter-error";

export interface ChatGptCaretEvidence {
  collapsed: boolean;
  anchorInsideComposer: boolean;
  focusInsideComposer: boolean;
  trailingEditableText: string;
}

const ZERO_WIDTH_TEXT = /[\u200B\u200C\u200D\u2060\uFEFF]/g;

function codePointWindow(value: string, offset: number): string {
  return Array.from(value.slice(offset), char => (
    `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`
  )).slice(0, 6).join(",");
}

const MARKDOWN_SHORTCUT_DELIMITERS = ["`", "*", "_", "~", "=", "[", ")"] as const;

type MarkdownReplacement = { marker: string; value: string; count: number };

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

export async function restoreChatGptPromptMarkdown(
  composer: Locator,
  replacements: MarkdownReplacement[],
  count: number,
): Promise<boolean> {
  await composer.focus();
  return composer.evaluate(async (element, input) => {
    const selection = window.getSelection();
    if (!selection) return false;
    const end = document.createRange();
    end.selectNodeContents(element);
    end.collapse(false);
    selection.removeAllRanges();
    selection.addRange(end);

    const rightmostText = (node: Node): Text | undefined => {
      if (node.nodeType === Node.TEXT_NODE) return node as Text;
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
    const cursor = (): { node: Text; offset: number } | undefined => {
      const anchor = selection.anchorNode;
      if (!anchor || (anchor !== element && !element.contains(anchor))) return undefined;
      if (anchor.nodeType === Node.TEXT_NODE) {
        const node = anchor as Text;
        return { node, offset: Math.min(selection.anchorOffset, node.data.length) };
      }
      for (let index = Math.min(selection.anchorOffset, anchor.childNodes.length) - 1; index >= 0; index -= 1) {
        const node = rightmostText(anchor.childNodes[index]!);
        if (node) return { node, offset: node.data.length };
      }
      const node = previousText(anchor);
      return node ? { node, offset: node.data.length } : undefined;
    };
    const previousMarker = (text: string, before: number) => {
      let match: { offset: number; value: string } | undefined;
      for (const replacement of input.replacements) {
        const offset = text.lastIndexOf(replacement.marker, before - 1);
        if (offset >= 0 && (!match || offset > match.offset)) match = { offset, value: replacement.value };
      }
      return match;
    };

    for (let remaining = input.count; remaining > 0; remaining -= 1) {
      let position = cursor();
      let match: { node: Text; offset: number; value: string } | undefined;
      while (position) {
        const found = previousMarker(position.node.data, position.offset);
        if (found) {
          match = { node: position.node, ...found };
          break;
        }
        const node = previousText(position.node);
        position = node ? { node, offset: node.data.length } : undefined;
      }
      if (!match) return false;
      const range = document.createRange();
      range.setStart(match.node, match.offset);
      range.setEnd(match.node, match.offset + 1);
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand("insertText", false, match.value)) return false;
      await Promise.resolve();
    }
    return true;
  }, { replacements, count }, { timeout: 20_000 });
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
