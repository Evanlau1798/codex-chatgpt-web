import { ChatGptWebAdapterError } from "./adapter-error";

export interface ParallelAdmissionIdentity { group: string; role: "root" | "worker" | "maintenance"; }
interface Waiter { identity: ParallelAdmissionIdentity; resolve: (release: () => void) => void;
  reject: (error: Error) => void; signal?: AbortSignal; abort?: () => void; }

/** One task tree at a time; its root never consumes either of its two child slots. */
export class ChatGptParallelAdmission {
  private group?: string;
  private root = false;
  private workers = 0;
  private maintenance = 0;
  private readonly queue: Waiter[] = [];

  private available(identity: ParallelAdmissionIdentity): boolean {
    return (!this.group || this.group === identity.group)
      && (identity.role === "root" ? !this.root : identity.role === "worker" ? this.workers < 2 : this.maintenance < 1);
  }
  private reserve(identity: ParallelAdmissionIdentity): () => void {
    this.group = identity.group;
    if (identity.role === "root") this.root = true;
    else if (identity.role === "worker") this.workers++;
    else this.maintenance++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (identity.role === "root") this.root = false;
      else if (identity.role === "worker") this.workers--;
      else this.maintenance--;
      if (!this.root && this.workers === 0 && this.maintenance === 0) this.group = undefined;
      this.drain();
    };
  }
  private drain(): void {
    // Skip an unrelated queued root so its parent cannot starve active children.
    for (let i = 0; i < this.queue.length;) {
      const waiter = this.queue[i]!;
      if (waiter.identity.role === "worker" && waiter.identity.group === this.group && this.workers >= 2) {
        this.queue.splice(i, 1);
        if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
        waiter.reject(this.childCapacity());
        continue;
      }
      if (!this.available(waiter.identity)) { i++; continue; }
      this.queue.splice(i, 1);
      if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.resolve(this.reserve(waiter.identity));
    }
  }
  async acquire(identity: ParallelAdmissionIdentity, signal?: AbortSignal): Promise<() => void> {
    if (!identity.group || identity.group.length > 512 || !["root", "worker", "maintenance"].includes(identity.role)) throw new Error("Invalid parallel admission identity");
    if (signal?.aborted) throw new DOMException("Queued browser request aborted", "AbortError");
    if (identity.role === "worker" && this.group === identity.group && this.workers >= 2) {
      // A third/nested child must not wait forever while both parents retain
      // their documents. Refuse before Send; never cancel active Pro work.
      throw this.childCapacity();
    }
    if (this.available(identity) && this.queue.length === 0) return this.reserve(identity);
    if (this.queue.length >= 64) throw new ChatGptWebAdapterError("Parallel browser admission queue is full; no provider Send was made.",
      { status: 409, errorType: "invalid_request_error", code: "parallel_queue_capacity", retryable: false });
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { identity, resolve, reject, signal };
      if (signal) {
        waiter.abort = () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          signal.removeEventListener("abort", waiter.abort!);
          reject(new DOMException("Queued browser request aborted", "AbortError"));
          this.drain();
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.queue.push(waiter);
      this.drain();
    });
  }
  async run<T>(identity: ParallelAdmissionIdentity, signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    const release = await this.acquire(identity, signal);
    try {
      if (signal?.aborted) throw new DOMException("Queued browser request aborted", "AbortError");
      return await task();
    } finally { release(); }
  }
  private childCapacity(): Error {
    return new ChatGptWebAdapterError("This parallel task already has two active workers; no provider Send was made for the excess worker.",
      { status: 409, errorType: "invalid_request_error", code: "parallel_child_capacity", retryable: false });
  }
}
export const chatGptParallelAdmission = new ChatGptParallelAdmission();
