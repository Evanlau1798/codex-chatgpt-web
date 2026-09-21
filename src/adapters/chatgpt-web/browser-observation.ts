import type { Page } from "playwright-core";
import { withAbort } from "./runtime-lifecycle";
import { ChatGptTurnIdentityAmbiguityError } from "./response-turn-boundary";
import type { ChatGptTurnProgressReader } from "./turn-progress";
import { chatGptSuspensionClock, isRecoverableChatGptViewportFailure } from "./browser-stage-lifecycle";

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
  remainingMs?: () => number,
) => Promise<Page>;

export class ChatGptObservationRecoveryExhaustedError extends Error {
  constructor(readonly attempts: number, cause?: unknown) {
    super(`ChatGPT browser DOM remained unresponsive after ${attempts} same-page rebinds or the recovery deadline`, { cause });
    this.name = "ChatGptObservationRecoveryExhaustedError";
  }
}

/** Shared by observation failures and failed readiness acquisition, not reset by MCP heartbeats. */
export class ChatGptObservationRecoveryEpisode {
  private attempts = 0;
  private startedAt: number | undefined;

  constructor(
    private readonly parentRemainingMs: () => number = () => Infinity,
    private readonly now: () => number = () => performance.now() - chatGptSuspensionClock.suspendedMs(),
    private readonly timeoutMs = 60_000,
  ) {}

  resetAfterObservation(): void { this.attempts = 0; this.startedAt = undefined; }

  async recover<T>(
    cause: ChatGptBrowserObservationTimeoutError,
    reconnect: (attempt: number, cause: ChatGptBrowserObservationTimeoutError, signal: AbortSignal, remainingMs: () => number) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    this.startedAt ??= this.now();
    const remaining = () => Math.max(0, Math.min(this.parentRemainingMs(), this.timeoutMs - (this.now() - this.startedAt!)));
    let lastError: unknown = cause;
    for (;;) {
      signal?.throwIfAborted();
      if (this.attempts >= MAX_CHATGPT_BROWSER_PAGE_REBINDS || remaining() <= 0) {
        throw new ChatGptObservationRecoveryExhaustedError(this.attempts, lastError);
      }
      this.attempts += 1;
      const controller = new AbortController();
      const attemptSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expire = () => {
        if (remaining() > 0) timer = setTimeout(expire, remaining());
        else controller.abort(new ChatGptObservationRecoveryExhaustedError(this.attempts, lastError));
      };
      timer = setTimeout(expire, remaining());
      try {
        // Only read-side recovery can be raced. Reconnect must dispose late acquired transports.
        const result = await withAbort(reconnect(this.attempts, cause, attemptSignal, remaining), attemptSignal);
        attemptSignal.throwIfAborted();
        if (remaining() <= 0) throw new ChatGptObservationRecoveryExhaustedError(this.attempts, lastError);
        return result;
      } catch (error) {
        attemptSignal.throwIfAborted();
        if (!isRecoverableChatGptViewportFailure(error)) throw error;
        lastError = error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        controller.abort();
      }
    }
  }
}

/** Retry only read-side observation, never the action that submitted the prompt. */
export async function withChatGptPageObservationRecovery<T>(
  page: Page,
  observe: (page: Page) => Promise<T>,
  recover?: ChatGptObservationRecovery,
  signal?: AbortSignal,
): Promise<T> {
  const episode = new ChatGptObservationRecoveryEpisode();
  for (;;) {
    signal?.throwIfAborted();
    try {
      const result = await observe(page);
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof ChatGptBrowserObservationTimeoutError) || !recover) throw error;
      page = await episode.recover(error, recover, signal);
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

/** Retry one transient post-Send identity read; a second ambiguity remains fail-closed. */
export async function observeChatGptTurnIdentityAfterSend<T>(
  operation: () => Promise<T>,
  settle: () => Promise<void>,
  signal?: AbortSignal,
): Promise<T | undefined> {
  signal?.throwIfAborted();
  try {
    const result = await operation();
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (!(error instanceof ChatGptTurnIdentityAmbiguityError)) throw error;
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    await (signal ? withAbort(settle(), signal) : settle());
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    const result = await operation();
    signal?.throwIfAborted();
    return result;
  }
}
