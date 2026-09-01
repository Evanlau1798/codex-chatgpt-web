export const CHATGPT_BROWSER_MUTATION_CLEANUP_MS = 5_000;

export class ChatGptBrowserMutationDeadlineError extends Error {
  constructor() {
    super("ChatGPT browser mutation exceeded its readiness deadline");
    this.name = "ChatGptBrowserMutationDeadlineError";
  }
}

export class ChatGptPersistentBrowserStateError extends AggregateError {
  constructor(errors: Iterable<unknown>, message: string) {
    super(errors, message);
    this.name = "ChatGptPersistentBrowserStateError";
  }
}

export async function runChatGptMutationCleanup<T>(
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHATGPT_BROWSER_MUTATION_CLEANUP_MS);
  timer.unref?.();
  try {
    return await action(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function remainingChatGptMutationMs(deadline: number, signal?: AbortSignal): number {
  if (signal?.aborted) throw new DOMException("ChatGPT browser mutation aborted", "AbortError");
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ChatGptBrowserMutationDeadlineError();
  return remaining;
}

export async function runChatGptMutationStep<T>(
  operation: () => Promise<T>,
  deadline: number,
  signal?: AbortSignal,
): Promise<T> {
  const timeoutMs = remainingChatGptMutationMs(deadline, signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const abort = signal
      ? new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new DOMException("ChatGPT browser mutation aborted", "AbortError"));
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        })
      : undefined;
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ChatGptBrowserMutationDeadlineError()), timeoutMs);
      }),
      ...(abort ? [abort] : []),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function runChatGptOwnedMutationStep<T>(
  operation: () => Promise<T>,
  deadline: number,
  signal: AbortSignal,
): Promise<T> {
  remainingChatGptMutationMs(deadline, signal);
  const result = await operation();
  remainingChatGptMutationMs(deadline, signal);
  return result;
}

export async function waitForChatGptMutationPoll(
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    await new Promise(resolve => setTimeout(resolve, timeoutMs));
    return;
  }
  if (signal.aborted) throw new DOMException("ChatGPT browser mutation aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: DOMException) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(new DOMException("ChatGPT browser mutation aborted", "AbortError"));
    const timer = setTimeout(finish, timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
