import { ChatGptPromptOperation } from "./prompt-operation";
import { chatGptPromptMismatchDetails } from "./prompt-text";
import type { Locator } from "playwright-core";
import { ChatGptPromptIntegrityMismatchError } from "./adapter-error";

export interface ChatGptCaretEvidence {
  collapsed: boolean;
  anchorInsideComposer: boolean;
  focusInsideComposer: boolean;
  trailingEditableText: string;
}

const ZERO_WIDTH_TEXT = /[\u200B\u200C\u200D\uFEFF]/g;

const CHATGPT_COMPOSER_SELECT_ALL_KEY = process.platform === "darwin" ? "Meta+A" : "Control+A";

export async function clearChatGptComposerInput(
  composer: Locator,
  abortSignal?: AbortSignal,
  operation?: ChatGptPromptOperation,
): Promise<void> {
  const op = (operation ?? new ChatGptPromptOperation(abortSignal)).budget(5_000);
  await op.mutate(options => composer.fill("", options));
  const hasText = await op.read(options => composer.evaluate(
    element => (element.textContent?.length ?? 0) > 0,
    undefined,
    options,
  ));
  if (!hasText) return;
  await op.mutate(options => composer.focus(options));
  await op.mutate(options => composer.press(CHATGPT_COMPOSER_SELECT_ALL_KEY, options));
  await op.mutate(options => composer.press("Backspace", options));
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
      const ignoredSelector = '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]';
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

      const textNodes: Node[] = [];
      const collectTextNodes = (node: Node): void => {
        if (node instanceof Element && node.matches(ignoredSelector)) return;
        if (node.nodeType === Node.TEXT_NODE) {
          if ((node.textContent ?? "").length > 0) textNodes.push(node);
          return;
        }
        if (node instanceof Element && node.tagName === "BR") {
          if (!node.classList.contains("ProseMirror-trailingBreak")) textNodes.push(node);
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
        if (lastTextNode.nodeType === Node.TEXT_NODE) {
          targetNode = lastTextNode;
          targetOffset = (lastTextNode as Text).data.length;
        } else {
          targetNode = lastTextNode.parentNode!;
          targetOffset = [...targetNode.childNodes].indexOf(lastTextNode as ChildNode) + 1;
        }
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
        for (const br of Array.from(remainder.querySelectorAll("br"))) {
          br.parentNode?.replaceChild(br.ownerDocument.createTextNode(
            br.classList.contains("ProseMirror-trailingBreak") ? "" : "\n"), br);
        }
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
