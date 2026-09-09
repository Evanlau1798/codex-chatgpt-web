import type { Locator } from "playwright-core";
import { chatGptWebSurfaceError } from "./adapter-error";
import { CHATGPT_PROMPT_INSERT_CHUNK_CHARS } from "./prompt-attachment-budget";
import {
  guardChatGptPromptMarkdown,
  guardChatGptPromptChunkBoundary,
  insertChatGptComposerGuardedText,
  restoreChatGptPromptMarkdown,
  restoreChatGptPromptChunkBoundary,
} from "./prompt-caret";

const BOUNDARY_LOOKBACK_CHARS = 4_096;
const WHITESPACE = /\s/u;

function promptInsertChunkEnd(text: string, offset: number): number {
  const hardEnd = Math.min(offset + CHATGPT_PROMPT_INSERT_CHUNK_CHARS, text.length);
  if (hardEnd >= text.length) return hardEnd;
  for (let candidate = hardEnd; candidate >= Math.max(offset + 1, hardEnd - BOUNDARY_LOOKBACK_CHARS); candidate -= 1) {
    if (!WHITESPACE.test(text[candidate] ?? "")) continue;
    let start = candidate;
    while (start > offset && WHITESPACE.test(text[start - 1] ?? "")) start -= 1;
    if (start > offset) return start;
  }
  const previous = text.charCodeAt(hardEnd - 1);
  const next = text.charCodeAt(hardEnd);
  return previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF
    ? hardEnd - 1
    : hardEnd;
}

export async function insertChatGptPromptText(
  text: string,
  abortSignal: AbortSignal | undefined,
  actions: {
    composer(): Promise<Locator>;
    verify(expected: string): Promise<void>;
    reanchor(): Promise<void>;
  },
): Promise<void> {
  const markdown = guardChatGptPromptMarkdown(text);
  const insertionText = markdown?.text ?? text;
  for (let offset = 0; offset < insertionText.length;) {
    if (abortSignal?.aborted) throw new DOMException("ChatGPT prompt attachment aborted", "AbortError");
    const end = promptInsertChunkEnd(insertionText, offset);
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
