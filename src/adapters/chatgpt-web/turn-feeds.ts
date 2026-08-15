export interface ChatGptTraceEvent {
  kind: "reasoning" | "commentary";
  text: string;
  continuation?: boolean;
}

interface FeedWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class ChatGptTraceFeed {
  private readonly queued: ChatGptTraceEvent[] = [];
  private readonly waiters = new Set<FeedWaiter>();
  private progressPending = false;

  push(event: ChatGptTraceEvent): void {
    const normalized = event.continuation ? event.text : event.text.trim();
    if (!normalized) return;
    this.queued.push({ ...event, text: normalized });
    this.wakeOne();
  }

  drain(): ChatGptTraceEvent[] {
    this.progressPending = false;
    return this.queued.splice(0);
  }

  signalProgress(): void {
    this.progressPending = true;
    this.wakeOne();
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.queued.length > 0 || this.progressPending) return Promise.resolve();
    return waitForFeed(this.waiters, "trace", signal);
  }

  private wakeOne(): void {
    const waiter = this.waiters.values().next().value as FeedWaiter | undefined;
    if (!waiter) return;
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
  }
}

/** Append-only browser Markdown feed. Waiters are notifications; `drain` owns consumption. */
export class ChatGptTextFeed {
  private readonly queued: string[] = [];
  private readonly waiters = new Set<FeedWaiter>();
  private text = "";

  push(delta: string): void {
    if (!delta) return;
    this.text += delta;
    this.queued.push(delta);
    const waiter = this.waiters.values().next().value as FeedWaiter | undefined;
    if (!waiter) return;
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
  }

  drain(): string[] { return this.queued.splice(0); }
  value(): string { return this.text; }
  wait(signal?: AbortSignal): Promise<void> {
    if (this.queued.length > 0) return Promise.resolve();
    return waitForFeed(this.waiters, "text", signal);
  }
}

function waitForFeed(waiters: Set<FeedWaiter>, name: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException(`${name} wait aborted`, "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const waiter: FeedWaiter = { resolve, reject, ...(signal ? { signal } : {}) };
    if (signal) {
      waiter.onAbort = () => {
        waiters.delete(waiter);
        reject(new DOMException(`${name} wait aborted`, "AbortError"));
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    waiters.add(waiter);
  });
}
