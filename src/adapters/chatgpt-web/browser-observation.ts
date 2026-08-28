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
