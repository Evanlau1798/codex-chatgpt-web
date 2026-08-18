import { randomBytes } from "node:crypto";
import { isUsableCompactionSummary } from "../../responses/compaction";

export interface CompactionTransactionHandle {
  token: string;
  handoffId: string;
}

type TransactionState = "pending" | "submitted";

interface TransactionWaiter {
  resolve: (summary: string) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface CompactionTransaction extends CompactionTransactionHandle {
  traceId: string;
  state: TransactionState;
  summary?: string;
  waiter?: TransactionWaiter;
  timer?: ReturnType<typeof setTimeout>;
}

function opaqueId(prefix: "control" | "handoff"): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export class CompactionTransactionStore {
  private readonly transactions = new Map<string, CompactionTransaction>();

  begin(traceId: string, ttlMs: number): CompactionTransactionHandle {
    if (!traceId.trim()) throw new Error("compaction transaction trace id is required");
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("compaction transaction TTL must be a positive finite number");
    }
    const transaction: CompactionTransaction = {
      token: opaqueId("control"),
      handoffId: opaqueId("handoff"),
      traceId,
      state: "pending",
    };
    transaction.timer = setTimeout(() => {
      this.finishError(transaction, new Error("compaction transaction timed out"));
    }, ttlMs);
    transaction.timer.unref?.();
    this.transactions.set(transaction.token, transaction);
    return { token: transaction.token, handoffId: transaction.handoffId };
  }

  submit(token: string, handoffId: string, summary: string): void {
    const transaction = this.transactions.get(token);
    if (!transaction) throw new Error("compaction control token is invalid, expired, or consumed");
    if (transaction.state !== "pending") throw new Error("compaction handoff was already submitted");
    if (handoffId !== transaction.handoffId) throw new Error("compaction handoff id does not match the pending transaction");
    if (!isUsableCompactionSummary(summary)) throw new Error("compaction handoff summary is not usable");
    transaction.state = "submitted";
    transaction.summary = summary.trim();
    if (transaction.timer) clearTimeout(transaction.timer);
    transaction.timer = undefined;
    if (transaction.waiter) this.consume(transaction);
  }

  wait(token: string, signal?: AbortSignal): Promise<string> {
    const transaction = this.transactions.get(token);
    if (!transaction) return Promise.reject(new Error("compaction control token is invalid, expired, or consumed"));
    if (transaction.waiter) return Promise.reject(new Error("compaction transaction already has a waiter"));
    if (transaction.state === "submitted") return Promise.resolve(this.consume(transaction));
    if (signal?.aborted) {
      this.finishError(transaction, new DOMException("compaction transaction aborted", "AbortError"));
      return Promise.reject(new DOMException("compaction transaction aborted", "AbortError"));
    }
    return new Promise<string>((resolve, reject) => {
      const waiter: TransactionWaiter = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => this.finishError(
          transaction,
          new DOMException("compaction transaction aborted", "AbortError"),
        );
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      transaction.waiter = waiter;
    });
  }

  abort(token: string): void {
    const transaction = this.transactions.get(token);
    if (!transaction || transaction.state === "submitted") return;
    this.finishError(transaction, new Error("compaction transaction aborted"));
  }

  abortTrace(traceId: string): void {
    for (const transaction of [...this.transactions.values()]) {
      if (transaction.traceId === traceId && transaction.state === "pending") {
        this.finishError(transaction, new Error("compaction transaction was revoked"));
      }
    }
  }

  close(): void {
    for (const transaction of [...this.transactions.values()]) {
      this.finishError(transaction, new Error("compaction transaction broker closed"));
    }
  }

  private consume(transaction: CompactionTransaction): string {
    const summary = transaction.summary;
    if (transaction.state !== "submitted" || summary === undefined) {
      throw new Error("compaction transaction is not ready to consume");
    }
    this.transactions.delete(transaction.token);
    this.detachWaiter(transaction);
    transaction.waiter?.resolve(summary);
    transaction.waiter = undefined;
    return summary;
  }

  private finishError(transaction: CompactionTransaction, error: Error): void {
    if (!this.transactions.delete(transaction.token)) return;
    if (transaction.timer) clearTimeout(transaction.timer);
    transaction.timer = undefined;
    const waiter = transaction.waiter;
    this.detachWaiter(transaction);
    transaction.waiter = undefined;
    waiter?.reject(error);
  }

  private detachWaiter(transaction: CompactionTransaction): void {
    const waiter = transaction.waiter;
    if (waiter?.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }
}
