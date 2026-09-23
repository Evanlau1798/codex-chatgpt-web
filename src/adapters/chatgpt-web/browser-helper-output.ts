import type { BrowserTurn } from "./browser-worker";
import type { BrokerTurnOutputEvent } from "./turn-broker-protocol";

type OutputSession = {
  events: BrokerTurnOutputEvent[];
  resumeAfter: number;
  waiter?: { after: number; resolve: (event: BrokerTurnOutputEvent) => void; reject: (error: Error) => void; signal?: AbortSignal; abort?: () => void };
  reset?: { requestId: number; finalSequence: number; resolve: () => void; reject: (error: Error) => void };
  seal?: { requestId: number; resolve: (sealed: boolean) => void; reject: (error: Error) => void };
};

export class BrowserHelperOutputRegistry {
  private readonly sessions = new Map<string, OutputSession>();
  private nextRequestId = 0;

  constructor(private readonly write: (message: unknown) => boolean) {}

  start(id: string, enabled: boolean): Pick<BrowserTurn, "tunneledOutput"> {
    if (!enabled) return {};
    const session: OutputSession = { events: [], resumeAfter: 0 };
    this.sessions.set(id, session);
    return { tunneledOutput: {
      next: (after, signal) => this.next(id, after, signal),
      reset: finalSequence => this.reset(id, finalSequence),
      seal: (afterSequence, expectedRevision) => this.seal(id, afterSequence, expectedRevision),
    } };
  }

  apply(id: string, event: BrokerTurnOutputEvent): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const expected = session.events.length + 1;
    if (!Number.isSafeInteger(event.sequence) || event.sequence !== expected
      || !["commentary", "reasoning", "final"].includes(event.kind)
      || typeof event.text !== "string" || !event.text) {
      throw new Error("Browser helper received invalid tunneled output");
    }
    session.events.push(event);
    if (session.waiter && event.sequence > session.waiter.after) {
      const waiter = session.waiter;
      session.waiter = undefined;
      waiter.resolve(event);
    }
  }

  resolveReset(id: string, requestId: number, reset: boolean): void {
    const session = this.sessions.get(id);
    const waiter = session?.reset;
    if (!waiter || waiter.requestId !== requestId) return;
    session!.reset = undefined;
    if (reset) { session!.resumeAfter = waiter.finalSequence; waiter.resolve(); }
    else waiter.reject(new Error("Browser helper output reset was rejected"));
  }

  resolveSeal(id: string, requestId: number, sealed: boolean): void {
    const session = this.sessions.get(id);
    const waiter = session?.seal;
    if (!waiter || waiter.requestId !== requestId) return;
    session!.seal = undefined;
    waiter.resolve(sealed);
  }

  end(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const error = new DOMException("Browser helper output mirror aborted", "AbortError");
    if (session.waiter?.signal && session.waiter.abort) session.waiter.signal.removeEventListener("abort", session.waiter.abort);
    session.waiter?.reject(error);
    session.reset?.reject(error);
    session.seal?.reject(error);
    this.sessions.delete(id);
  }

  close(): void { for (const id of this.sessions.keys()) this.end(id); }

  private next(id: string, after: number, signal?: AbortSignal): Promise<BrokerTurnOutputEvent> {
    const session = this.sessions.get(id);
    if (!session) return Promise.reject(new Error("Browser helper output mirror is unavailable"));
    const effectiveAfter = Math.max(after, session.resumeAfter);
    const ready = session.events.find(event => event.sequence > effectiveAfter);
    if (ready) return Promise.resolve(ready);
    if (session.waiter) return Promise.reject(new Error("Browser helper output mirror already has a waiter"));
    if (signal?.aborted) return Promise.reject(new DOMException("Browser helper output wait aborted", "AbortError"));
    return new Promise((resolve, reject) => {
      const abort = () => { if (session.waiter?.reject === reject) session.waiter = undefined; reject(new DOMException("Browser helper output wait aborted", "AbortError")); };
      session.waiter = { after: effectiveAfter, resolve: event => { signal?.removeEventListener("abort", abort); resolve(event); }, reject, ...(signal ? { signal, abort } : {}) };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private reset(id: string, finalSequence: number): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return Promise.reject(new Error("Browser helper output mirror is unavailable"));
    if (session.reset) return Promise.reject(new Error("Browser helper output reset is already pending"));
    return new Promise((resolve, reject) => {
      const requestId = ++this.nextRequestId;
      session.reset = { requestId, finalSequence, resolve, reject };
      if (this.write({ type: "event", id, event: "tunneled_output_reset", requestId, finalSequence })) return;
      session.reset = undefined;
      reject(new Error("Browser helper could not request an output reset"));
    });
  }

  private seal(id: string, afterSequence: number, expectedRevision: number): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return Promise.reject(new Error("Browser helper output mirror is unavailable"));
    if (session.seal) return Promise.reject(new Error("Browser helper output seal is already pending"));
    return new Promise((resolve, reject) => {
      const requestId = ++this.nextRequestId;
      session.seal = { requestId, resolve, reject };
      if (this.write({ type: "event", id, event: "tunneled_output_seal", requestId, afterSequence, expectedRevision })) return;
      session.seal = undefined;
      reject(new Error("Browser helper could not request an output seal"));
    });
  }
}
