/**
 * ChatGPT Web concurrency is deliberately bounded. Every active Codex turn owns a real
 * browser document in the signed-in account, so unbounded fan-out would create account-level
 * traffic that is indistinguishable from spam.
 */
export const MAX_CHATGPT_BROWSER_TABS = 6;
export const ORIGINAL_CHATGPT_BROWSER_TABS = 5;

type SlotWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  limit: number;
};

let activeSlots = 0;
const slotWaiters: SlotWaiter[] = [];

function grantNextSlot(): void {
  const waiter = slotWaiters[0];
  if (!waiter || activeSlots >= waiter.limit) return;
  slotWaiters.shift();
  if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  activeSlots += 1;
  waiter.resolve();
}

function releaseSlot(): void {
  activeSlots -= 1;
  grantNextSlot();
}

async function acquireSlot(signal: AbortSignal | undefined, limit: number): Promise<void> {
  if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
  if (activeSlots < limit && slotWaiters.length === 0) {
    activeSlots += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: SlotWaiter = { resolve, reject, limit, ...(signal ? { signal } : {}) };
    if (signal) {
      waiter.onAbort = () => {
        const index = slotWaiters.indexOf(waiter);
        if (index >= 0) slotWaiters.splice(index, 1);
        reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
        if (index === 0) grantNextSlot();
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    slotWaiters.push(waiter);
  });
}

export async function runWithChatGptBrowserSlot<T>(
  signal: AbortSignal | undefined,
  task: () => Promise<T>,
  limit = MAX_CHATGPT_BROWSER_TABS,
): Promise<T> {
  await acquireSlot(signal, limit);
  try {
    return await task();
  } finally {
    releaseSlot();
  }
}
