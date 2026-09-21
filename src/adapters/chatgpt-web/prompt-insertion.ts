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
  const checkAborted = (): void => {
    if (abortSignal?.aborted) {
      throw abortSignal.reason ?? new DOMException("ChatGPT prompt attachment aborted", "AbortError");
    }
  };
  // Await the real operation: rejecting a race on cancellation does not settle an editor edit.
  const checked = async <T>(action: () => Promise<T>): Promise<T> => {
    checkAborted();
    const result = await action();
    checkAborted();
    return result;
  };
  const withComposer = async <T>(action: (composer: Locator) => Promise<T>): Promise<T> => {
    const composer = await checked(() => actions.composer());
    return checked(() => action(composer));
  };
  const verify = (expected: string) => checked(() => actions.verify(expected));
  const reanchor = () => checked(() => actions.reanchor());

  checkAborted();
  const plan = planChatGptPromptInsertion(text, options);
  if (plan.strategy !== "guarded-chunked") {
    // One exact editor transaction avoids both cumulative Lexical remounts and thousands of
    // delimiter-restoration edits. Full readback remains the acceptance boundary.
    await verify("");
    // HTML parsing changes CR and NUL; retain the exact text path for those inputs.
    const plainTextBlocks = plan.strategy === "direct-html";
    await withComposer(composer => insertChatGptComposerGuardedText(composer, text, abortSignal, plainTextBlocks));
    await verify(text.trimStart());
    await checked(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    await verify(text.trimStart());
    await reanchor();
    return;
  }
  const markdown = guardChatGptPromptMarkdown(text);
  const insertionText = markdown?.text ?? text;
  for (let offset = 0; offset < insertionText.length;) {
    checkAborted();
    const end = chatGptPromptInsertChunkEnd(insertionText, offset);
    const original = insertionText.slice(offset, end);
    const boundary = guardChatGptPromptChunkBoundary(insertionText, original, offset);
    const chunk = boundary?.text ?? original;
    await withComposer(composer => insertChatGptComposerGuardedText(composer, chunk, abortSignal));
    await verify(`${insertionText.slice(0, offset)}${chunk}`.trimStart());
    if (boundary) {
      if (!await withComposer(composer => restoreChatGptPromptChunkBoundary(composer, boundary.replacement, abortSignal))) {
        throw chatGptWebSurfaceError("ChatGPT composer could not restore a prompt chunk boundary", false);
      }
      await verify(insertionText.slice(0, end).trimStart());
    }
    if (end < insertionText.length || boundary) await reanchor();
    offset = end;
  }
  if (markdown) {
    await withComposer(composer => restoreChatGptPromptMarkdown(composer, text, markdown, abortSignal));
    await verify(text.trimStart());
    await reanchor();
  }
}
