import type { Locator } from "playwright-core";
import { chatGptWebSurfaceError } from "./adapter-error";
import {
  chatGptPromptInsertChunkEnd,
  planChatGptPromptInsertion,
  type ChatGptPromptInsertionOptions,
} from "./prompt-insertion-plan";
import {
  guardChatGptPromptMarkdown,
  guardChatGptPromptChunkBoundary,
  insertChatGptComposerGuardedText,
  restoreChatGptPromptMarkdown,
  restoreChatGptPromptChunkBoundary,
} from "./prompt-caret";

export async function insertChatGptPromptText(
  text: string,
  abortSignal: AbortSignal | undefined,
  actions: {
    composer(): Promise<Locator>;
    verify(expected: string): Promise<void>;
    reanchor(): Promise<void>;
  },
  options?: ChatGptPromptInsertionOptions,
): Promise<void> {
  const plan = planChatGptPromptInsertion(text, options);
  if (plan.strategy !== "guarded-chunked") {
    // One exact editor transaction avoids both cumulative Lexical remounts and thousands of
    // delimiter-restoration edits. Full readback remains the acceptance boundary.
    await actions.verify("");
    // HTML parsing changes CR and NUL; retain the exact text path for those inputs.
    const plainTextBlocks = plan.strategy === "direct-html";
    await insertChatGptComposerGuardedText(await actions.composer(), text, abortSignal, plainTextBlocks);
    await actions.verify(text.trimStart());
    await new Promise(resolve => setTimeout(resolve, 0));
    if (abortSignal?.aborted) throw abortSignal.reason ?? new DOMException("ChatGPT prompt attachment aborted", "AbortError");
    await actions.verify(text.trimStart());
    await actions.reanchor();
    return;
  }
  const markdown = guardChatGptPromptMarkdown(text);
  const insertionText = markdown?.text ?? text;
  for (let offset = 0; offset < insertionText.length;) {
    if (abortSignal?.aborted) throw new DOMException("ChatGPT prompt attachment aborted", "AbortError");
    const end = chatGptPromptInsertChunkEnd(insertionText, offset);
    const original = insertionText.slice(offset, end);
    const boundary = guardChatGptPromptChunkBoundary(insertionText, original, offset);
    const chunk = boundary?.text ?? original;
    await insertChatGptComposerGuardedText(await actions.composer(), chunk, abortSignal);
    await actions.verify(`${insertionText.slice(0, offset)}${chunk}`.trimStart());
    if (boundary) {
      if (!await restoreChatGptPromptChunkBoundary(await actions.composer(), boundary.replacement, abortSignal)) {
        throw chatGptWebSurfaceError("ChatGPT composer could not restore a prompt chunk boundary", false);
      }
      await actions.verify(insertionText.slice(0, end).trimStart());
    }
    if (end < insertionText.length || boundary) await actions.reanchor();
    offset = end;
  }
  if (markdown) {
    await restoreChatGptPromptMarkdown(await actions.composer(), text, markdown, abortSignal);
    await actions.verify(text.trimStart());
    await actions.reanchor();
  }
}
