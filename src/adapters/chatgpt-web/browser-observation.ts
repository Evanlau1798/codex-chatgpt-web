import type { Page } from "playwright-core";
import { withAbort } from "./runtime-lifecycle";
import type { ChatGptTurnProgressReader } from "./turn-progress";

export const CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS = 5_000;
export const MAX_CHATGPT_BROWSER_PAGE_REBINDS = 2;

export class ChatGptBrowserObservationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`ChatGPT browser DOM observation did not respond within ${timeoutMs}ms`);
    this.name = "ChatGptBrowserObservationTimeoutError";
  }
}

export async function withChatGptBrowserObservationTimeout<T>(
  operation: Promise<T>,
  timeoutMs = CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ChatGptBrowserObservationTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type ChatGptObservationRecovery = (
  attempt: number,
  cause: ChatGptBrowserObservationTimeoutError,
  signal?: AbortSignal,
) => Promise<Page>;

/** Retry only read-side observation, never the action that submitted the prompt. */
export async function withChatGptPageObservationRecovery<T>(
  page: Page,
  observe: (page: Page) => Promise<T>,
  recover?: ChatGptObservationRecovery,
  signal?: AbortSignal,
): Promise<T> {
  let attempts = 0;
  for (;;) {
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    try {
      return await observe(page);
    } catch (error) {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      if (!(error instanceof ChatGptBrowserObservationTimeoutError) || !recover) throw error;
      if (++attempts > MAX_CHATGPT_BROWSER_PAGE_REBINDS) {
        throw new Error(
          `ChatGPT submission DOM remained unresponsive after ${MAX_CHATGPT_BROWSER_PAGE_REBINDS} same-page rebinds`,
          { cause: error },
        );
      }
      page = await recover(attempts, error, signal);
    }
  }
}

/** A proven MCP update may wake a stalled read, but is never DOM/completion evidence. */
export async function observeChatGptSubmission<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  progress?: ChatGptTurnProgressReader,
  revision = progress?.snapshot().revision ?? 0,
): Promise<{ value: T } | undefined> {
  const waiting = new AbortController();
  const observationSignal = signal ? AbortSignal.any([waiting.signal, signal]) : waiting.signal;
  try {
    const observation = withChatGptBrowserObservationTimeout(withAbort(operation(observationSignal), observationSignal))
      .then(value => ({ value }));
    return await (progress ? Promise.race([
      observation,
      progress.waitForChange(revision, observationSignal).then(() => undefined),
    ]) : observation);
  } finally {
    waiting.abort();
  }
}
