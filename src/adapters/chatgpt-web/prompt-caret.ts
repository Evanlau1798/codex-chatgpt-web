import type { Locator } from "playwright-core";

export interface ChatGptCaretEvidence {
  collapsed: boolean;
  anchorInsideComposer: boolean;
  focusInsideComposer: boolean;
  trailingEditableText: string;
}

const ZERO_WIDTH_TEXT = /[\u200B\u200C\u200D\u2060\uFEFF]/g;

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
