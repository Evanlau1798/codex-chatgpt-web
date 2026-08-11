/**
 * ChatGPT Web concurrency is deliberately bounded. Every active Codex turn owns a real
 * browser document in the signed-in account, so unbounded fan-out would create account-level
 * traffic that is indistinguishable from spam.
 */
export const MAX_CHATGPT_BROWSER_TABS = 6;

type SlotWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

let activeSlots = 0;
const slotWaiters: SlotWaiter[] = [];

function releaseSlot(): void {
  const waiter = slotWaiters.shift();
  if (!waiter) {
    activeSlots -= 1;
    return;
  }
  if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  waiter.resolve();
}

async function acquireSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
  if (activeSlots < MAX_CHATGPT_BROWSER_TABS && slotWaiters.length === 0) {
    activeSlots += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: SlotWaiter = { resolve, reject, ...(signal ? { signal } : {}) };
    if (signal) {
      waiter.onAbort = () => {
        const index = slotWaiters.indexOf(waiter);
        if (index >= 0) slotWaiters.splice(index, 1);
        reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    slotWaiters.push(waiter);
  });
}

export async function runWithChatGptBrowserSlot<T>(
  signal: AbortSignal | undefined,
  task: () => Promise<T>,
): Promise<T> {
  await acquireSlot(signal);
  try {
    return await task();
  } finally {
    releaseSlot();
  }
}
