import { ChatGptPromptOperation } from "./prompt-operation";
import { ChatGptPromptInsertionMetrics, type ChatGptPromptInsertionSnapshot } from "./prompt-insertion-metrics";
import type { Locator } from "playwright-core";
import { chatGptWebSurfaceError } from "./adapter-error";
import {
  chatGptPromptInsertChunkEnd,
  planChatGptPromptInsertion,
  type ChatGptPromptInsertionOptions,
  type ChatGptPromptInsertionPlan,
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
    onProgress?(snapshot: ChatGptPromptInsertionSnapshot): void;
  },
  options?: ChatGptPromptInsertionOptions,
  operation?: ChatGptPromptOperation,
  selectedPlan?: ChatGptPromptInsertionPlan,
): Promise<void> {
  const op = operation ?? new ChatGptPromptOperation(abortSignal);
  const checkAborted = (): void => {
    op.check();
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
  const verify = (expected: string, final = false) => metrics.run(final ? "final_verify" : "verify", async () => {
    await checked(() => actions.verify(expected));
    metrics.verified(expected.length);
  });
  const reanchor = () => metrics.run("reanchor", () => checked(() => actions.reanchor()));

  checkAborted();
  const plan = selectedPlan ?? planChatGptPromptInsertion(text, options);
  const metrics = new ChatGptPromptInsertionMetrics(plan, actions.onProgress, op.now);
  try {
    if (plan.strategy !== "guarded-chunked") {
      // One bounded insertion avoids cumulative editor remounts and thousands of
      // delimiter-restoration edits. Full readback remains the acceptance boundary.
      await verify("");
      // HTML parsing changes CR and NUL; retain the exact text path for those inputs.
      const htmlShape = plan.strategy === "direct-html-prewrap" ? "prewrap" : plan.strategy === "direct-html";
      await metrics.run("insert", async () => {
        metrics.chunk();
        await withComposer(composer => insertChatGptComposerGuardedText(composer, text, abortSignal, htmlShape, metrics, op));
        metrics.inserted(text.length);
      });
      const expected = plan.strategy === "direct-html-prewrap" ? text : text.trimStart();
      await verify(expected);
      await checked(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
      await verify(expected, true);
      await reanchor();
      return;
    }
    const markdown = guardChatGptPromptMarkdown(text);
    const insertionText = markdown?.text ?? text;
    metrics.markers(markdown?.count ?? 0);
    for (let offset = 0; offset < insertionText.length;) {
      checkAborted();
      const end = chatGptPromptInsertChunkEnd(insertionText, offset);
      const original = insertionText.slice(offset, end);
      const boundary = guardChatGptPromptChunkBoundary(insertionText, original, offset);
      const chunk = boundary?.text ?? original;
      await metrics.run("insert", async () => {
        metrics.chunk();
        await withComposer(composer => insertChatGptComposerGuardedText(composer, chunk, abortSignal, false, metrics, op));
        metrics.inserted(end);
      });
      await verify(`${insertionText.slice(0, offset)}${chunk}`.trimStart());
      if (boundary) {
        if (!await metrics.run("boundary_restore", () => withComposer(composer => restoreChatGptPromptChunkBoundary(composer, boundary.replacement, abortSignal, metrics, op)))) {
          throw chatGptWebSurfaceError("ChatGPT composer could not restore a prompt chunk boundary", false);
        }
        await verify(insertionText.slice(0, end).trimStart());
      }
      if (end < insertionText.length || boundary) await reanchor();
      offset = end;
    }
    if (markdown) {
      await metrics.run("markdown_restore", () => withComposer(composer => restoreChatGptPromptMarkdown(composer, text, markdown, abortSignal, metrics, op)));
      await verify(text.trimStart(), true);
      await reanchor();
    }
  } finally { metrics.finish(); }
}
