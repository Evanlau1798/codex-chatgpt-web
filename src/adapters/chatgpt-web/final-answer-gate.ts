import type { ChatGptRetryPrompt } from "./steering";
import type { ChatGptMarkdownBuffer } from "./markdown";
import type { CapturedChatGptLunaCheckpoint, ChatGptLunaCheckpointStream } from "./rolling-checkpoint";

interface CompletionFence {
  commit(revision: number): Promise<boolean>;
}

interface FinalAnswerGateOptions {
  answer: string;
  attempt: number;
  preemptiveRetryPrompt?: string;
  retryPromptForAnswer?: (
    answer: string,
    attempt: number,
  ) => string | ChatGptRetryPrompt | undefined | Promise<string | ChatGptRetryPrompt | undefined>;
  completionFence?: CompletionFence;
  completionFenceRevision?: number;
  completionAdmission?: {
    seal(): boolean;
    reopen(): void;
  };
  abortSignal?: AbortSignal;
  finalizeAnswer?: () => string;
}

export type FinalAnswerGateDecision =
  | { status: "complete"; answer: string }
  | { status: "observe" }
  | { status: "retry"; retry: ChatGptRetryPrompt };

export class ChatGptFinalAnswerDecisionError extends Error {
  constructor(readonly original: Error, readonly completionCommitted: boolean) {
    super(original.message, { cause: original });
    this.name = "ChatGptFinalAnswerDecisionError";
  }
}

export function prepareChatGptFinalAnswer(options: {
  markdown: ChatGptMarkdownBuffer;
  checkpoint?: ChatGptLunaCheckpointStream;
  visibleText: string;
  plainTextFallback: string;
  emitMarkdownDelta: (delta: string) => void;
  onTextDelta: (delta: string) => void;
  onCheckpoint?: (captured: CapturedChatGptLunaCheckpoint) => void;
  onMissingCheckpoint: () => void;
  normalizeMarkdownError: (error: unknown) => never;
}): { preview: string; finalize: () => string } {
  let previewMarkdown: string;
  try { previewMarkdown = options.markdown.preview(); }
  catch (error) { return options.normalizeMarkdownError(error); }
  if (!previewMarkdown && !options.plainTextFallback && options.visibleText) {
    throw new Error("ChatGPT completed with visible text that could not be serialized as Markdown");
  }
  const preview = options.checkpoint
    ? options.checkpoint.previewOptional(options.visibleText).answer
    : previewMarkdown || options.plainTextFallback;
  return {
    preview,
    finalize: () => {
      let final: ReturnType<ChatGptMarkdownBuffer["finish"]>;
      try { final = options.markdown.finish(); }
      catch (error) { return options.normalizeMarkdownError(error); }
      if (!final.markdown && options.plainTextFallback) options.emitMarkdownDelta(options.plainTextFallback);
      if (final.delta) options.emitMarkdownDelta(final.delta);
      if (!options.checkpoint) return final.markdown || options.plainTextFallback;
      const completed = options.checkpoint.finishOptional(options.visibleText);
      if (completed.visibleRemainder) options.onTextDelta(completed.visibleRemainder);
      if (completed.captured) options.onCheckpoint?.(completed.captured);
      else options.onMissingCheckpoint();
      return completed.answer;
    },
  };
}

/** Select a same-surface retry before making browser completion irreversible. */
export async function decideChatGptFinalAnswer(
  options: FinalAnswerGateOptions,
): Promise<FinalAnswerGateDecision> {
  if (options.completionAdmission && !options.completionAdmission.seal()) {
    return { status: "observe" };
  }
  let completionCommitted = false;
  try {
    const selected = options.preemptiveRetryPrompt
      ?? await options.retryPromptForAnswer?.(options.answer, options.attempt);
    if (selected !== undefined) {
      options.completionAdmission?.reopen();
      return { status: "retry", retry: typeof selected === "string" ? { text: selected } : selected };
    }
    options.abortSignal?.throwIfAborted();
    if (options.completionFence) {
      const revision = options.completionFenceRevision;
      if (revision === undefined || !await options.completionFence.commit(revision)) {
        options.completionAdmission?.reopen();
        return { status: "observe" };
      }
    }
    completionCommitted = true;
    return { status: "complete", answer: options.finalizeAnswer?.() ?? options.answer };
  } catch (error) {
    throw new ChatGptFinalAnswerDecisionError(
      error instanceof Error ? error : new Error(String(error)),
      completionCommitted,
    );
  }
}
