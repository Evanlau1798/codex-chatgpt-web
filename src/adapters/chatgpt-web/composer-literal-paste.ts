import type { Locator } from "playwright-core";
import { ChatGptPromptOperation } from "./prompt-operation";
import { chatGptWebSurfaceError } from "./adapter-error";
import { chatGptNativeEditValue, type ChatGptPromptInsertionMetrics } from "./prompt-insertion-metrics";

/** One public editor paste, no OS clipboard access, HTML, editor internals or markers. */
export async function pasteChatGptComposerLiteralText(
  composer: Locator,
  text: string,
  abortSignal?: AbortSignal,
  metrics?: ChatGptPromptInsertionMetrics,
  operation?: ChatGptPromptOperation,
  recoverCaret?: () => Promise<void>,
): Promise<void> {
  const op = operation ?? new ChatGptPromptOperation(abortSignal);
  await op.mutate(options => composer.focus(options));
  metrics?.editStarted();
  const edit = await op.mutate(options => composer.evaluate((element, value) => {
    const selection = window.getSelection();
    if (document.activeElement !== element || !selection?.isCollapsed
      || !selection.anchorNode || !selection.focusNode
      || !element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) {
      return { result: false, attempts: 0, accepted: 0 };
    }
    const data = new DataTransfer();
    data.setData("text/plain", value.text);
    // The editor's public paste-as-plain shortcut suppresses Markdown conversion
    // and paste-as-file. It changes editor state through its own event handlers.
    element.dispatchEvent(new KeyboardEvent("keydown", {
      key: "V", code: "KeyV", ctrlKey: !value.metaKey, metaKey: value.metaKey,
      shiftKey: true, bubbles: true,
    }));
    let handled: boolean;
    try {
      handled = !element.dispatchEvent(new ClipboardEvent("paste", {
        clipboardData: data, bubbles: true, cancelable: true,
      }));
    } finally {
      element.dispatchEvent(new KeyboardEvent("keyup", {
        key: "Shift", code: "ShiftLeft", shiftKey: false, bubbles: true,
      }));
    }
    // Handling is not proof of text integrity: require settled readback before Send.
    return { result: handled, attempts: 1, accepted: handled ? 1 : 0 };
  }, { text, metaKey: process.platform === "darwin" }, options));
  const accepted = chatGptNativeEditValue(edit, metrics);
  if (!accepted && recoverCaret && typeof edit === "object" && edit !== null && edit.attempts === 0) {
    await recoverCaret();
    return pasteChatGptComposerLiteralText(composer, text, abortSignal, metrics, op);
  }
  if (!accepted) throw chatGptWebSurfaceError("ChatGPT composer rejected the literal plain-text paste", false);
}
