import {
  httpStreamFailureDiagnostic,
  reportHttpStreamFailure,
  reportHttpStreamTiming,
  safeDiagnosticIdentifier,
  safeDiagnosticRoute,
  safeErrorMetadata,
  type HttpStreamFailureReporter,
  type HttpStreamTimingDiagnostic,
  type HttpStreamTimingReporter,
} from "./http-stream-diagnostics";

type Clock = () => number;
type StreamStage = HttpStreamTimingDiagnostic["stage"];
type StreamOutcome = HttpStreamTimingDiagnostic["outcome"];

export interface NativeCodexTurnIdentity { threadId: string; turnId: string }

interface StreamCounters {
  chunks: number;
  bytes: number;
  firstChunkMs: number | null;
  maxChunkGapMs: number;
  lastChunkAt: number | null;
}

function elapsed(now: number, startedAt: number): number {
  return Math.max(0, Math.round(now - startedAt));
}

export class HttpTurnCounter {
  private readonly active = new Map<number, {
    abort: AbortController;
    done: Promise<void>;
    finish: () => void;
    identity?: NativeCodexTurnIdentity;
  }>();
  private readonly interrupted = new Map<string, unknown>();
  private nextId = 1;

  constructor(
    private readonly reportStreamFailure: HttpStreamFailureReporter = reportHttpStreamFailure,
    private readonly reportStreamTiming: HttpStreamTimingReporter = reportHttpStreamTiming,
    private readonly now: Clock = () => performance.now(),
  ) {}

  count(): number {
    return this.active.size;
  }

  async cancelAll(reason: unknown = new Error("Active HTTP turns cancelled")): Promise<number> {
    const turns = [...this.active.values()];
    for (const turn of turns) {
      if (!turn.abort.signal.aborted) turn.abort.abort(reason);
    }
    await Promise.all(turns.map(turn => turn.done));
    return turns.length;
  }

  async track(
    run: (signal: AbortSignal, bindIdentity: (identity: NativeCodexTurnIdentity) => void) => Promise<Response>,
    clientSignal?: AbortSignal,
    platform: NodeJS.Platform = process.platform,
    route = "unknown",
  ): Promise<Response> {
    const startedAt = this.now();
    const id = this.nextId++;
    const abort = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    this.active.set(id, { abort, done, finish });
    let released = false;
    let timingReported = false;
    let clientAbortListener: (() => void) | undefined;
    let streamAbortListener: (() => void) | undefined;
    let headersMs = 0;
    let status: number | null = null;
    let requestId: string | null = null;
    const counters: StreamCounters = {
      chunks: 0,
      bytes: 0,
      firstChunkMs: null,
      maxChunkGapMs: 0,
      lastChunkAt: null,
    };
    const release = () => {
      if (released) return;
      released = true;
      this.active.delete(id);
      if (clientSignal && clientAbortListener) {
        clientSignal.removeEventListener("abort", clientAbortListener);
        clientAbortListener = undefined;
      }
      if (streamAbortListener) abort.signal.removeEventListener("abort", streamAbortListener);
      finish();
    };
    const observeChunk = (chunk: Uint8Array) => {
      const observedAt = this.now();
      const observedMs = elapsed(observedAt, startedAt);
      if (counters.lastChunkAt !== null) {
        counters.maxChunkGapMs = Math.max(counters.maxChunkGapMs, elapsed(observedAt, counters.lastChunkAt));
      }
      counters.lastChunkAt = observedAt;
      counters.firstChunkMs ??= observedMs;
      counters.chunks += 1;
      counters.bytes += chunk.byteLength;
    };
    const finalize = (outcome: StreamOutcome, stage: StreamStage, error?: unknown) => {
      if (!timingReported) {
        timingReported = true;
        const safeError = error === undefined ? null : safeErrorMetadata(error);
        const timing: HttpStreamTimingDiagnostic = {
          route: safeDiagnosticRoute(route),
          stage,
          platform,
          status,
          requestId,
          outcome,
          headersMs,
          firstChunkMs: counters.firstChunkMs,
          maxChunkGapMs: counters.maxChunkGapMs,
          totalMs: elapsed(this.now(), startedAt),
          chunks: counters.chunks,
          bytes: counters.bytes,
          errorName: safeError?.errorName ?? null,
          errorCode: safeError?.errorCode ?? null,
        };
        try {
          this.reportStreamTiming(timing);
        } catch {
          // Diagnostics must never affect the response lifecycle.
        }
      }
      release();
    };
    clientAbortListener = () => abort.abort(clientSignal?.reason);
    if (clientSignal?.aborted) abort.abort(clientSignal.reason);
    else clientSignal?.addEventListener("abort", clientAbortListener, { once: true });

    try {
      const response = await run(abort.signal, identity => {
        if (!identity.threadId.trim() || !identity.turnId.trim()) throw new Error("Native Codex turn identity requires threadId and turnId");
        const tracked = this.active.get(id)!;
        if (tracked.identity && (tracked.identity.threadId !== identity.threadId || tracked.identity.turnId !== identity.turnId)) {
          throw new Error("An HTTP request cannot change its native Codex turn identity");
        }
        tracked.identity = { ...identity };
        const key = JSON.stringify([identity.threadId, identity.turnId]);
        if (this.interrupted.has(key) && !abort.signal.aborted) abort.abort(this.interrupted.get(key));
      });
      headersMs = elapsed(this.now(), startedAt);
      status = response.status;
      requestId = safeDiagnosticIdentifier(response.headers.get("x-request-id"));
      if (!response.body) {
        finalize("completed", "headers");
        return response;
      }
      if (abort.signal.aborted) {
        await response.body.cancel(abort.signal.reason).catch(() => {});
        status = 499;
        finalize("aborted", "headers", abort.signal.reason);
        return new Response(null, { status: 499, statusText: "Client Closed Request" });
      }

      if (platform !== "win32") {
        // Bun's async-pull teardown bug is Windows-only. Preserve the direct pull chain elsewhere.
        return this.trackDirectStream(
          response,
          abort,
          counters,
          observeChunk,
          finalize,
          listener => { streamAbortListener = listener; },
          platform,
        );
      }
      // On Windows the client receives a native tee branch while the lifecycle branch is drained
      // eagerly. This preserves the Bun#32111 workaround without placing a slow observer upstream.
      return this.trackWindowsStream(
        response,
        abort,
        counters,
        observeChunk,
        finalize,
        listener => { streamAbortListener = listener; },
        platform,
      );
    } catch (error) {
      headersMs = elapsed(this.now(), startedAt);
      finalize(abort.signal.aborted ? "aborted" : "failed", "headers", error);
      throw error;
    }
  }

  beginCancelTurn(identity: NativeCodexTurnIdentity, reason: unknown = new DOMException("Codex turn interrupted", "AbortError")) {
    const key = JSON.stringify([identity.threadId, identity.turnId]);
    this.interrupted.delete(key);
    this.interrupted.set(key, reason);
    while (this.interrupted.size > 1_024) this.interrupted.delete(this.interrupted.keys().next().value!);
    const turns = [...this.active.values()].filter(turn => turn.identity?.threadId === identity.threadId && turn.identity.turnId === identity.turnId);
    for (const turn of turns) if (!turn.abort.signal.aborted) turn.abort.abort(reason);
    return { cancelled: turns.length, settlement: Promise.all(turns.map(turn => turn.done)).then(() => undefined) };
  }

  async cancelTurn(identity: NativeCodexTurnIdentity, reason?: unknown): Promise<number> {
    const cancellation = this.beginCancelTurn(identity, reason);
    await cancellation.settlement;
    return cancellation.cancelled;
  }

  private trackDirectStream(
    response: Response,
    abort: AbortController,
    counters: StreamCounters,
    observeChunk: (chunk: Uint8Array) => void,
    finalize: (outcome: StreamOutcome, stage: StreamStage, error?: unknown) => void,
    setAbortListener: (listener: () => void) => void,
    platform: NodeJS.Platform,
  ): Response {
    const reader = response.body!.getReader();
    const listener = () => {
      void reader.cancel(abort.signal.reason).catch(() => {}).finally(() => {
        finalize("aborted", "direct", abort.signal.reason);
      });
    };
    setAbortListener(listener);
    abort.signal.addEventListener("abort", listener, { once: true });
    const body = new ReadableStream<Uint8Array>({
      pull: async controller => {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            finalize(abort.signal.aborted ? "aborted" : "completed", "direct", abort.signal.reason);
            controller.close();
            return;
          }
          observeChunk(chunk.value);
          controller.enqueue(chunk.value);
        } catch (error) {
          if (!abort.signal.aborted) this.reportFailure(error, "direct", counters, platform);
          finalize(abort.signal.aborted ? "aborted" : "failed", "direct", error);
          controller.error(error);
        }
      },
      cancel: async reason => {
        try {
          await reader.cancel(reason);
        } finally {
          finalize("cancelled", "direct");
        }
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  private trackWindowsStream(
    response: Response,
    abort: AbortController,
    counters: StreamCounters,
    observeChunk: (chunk: Uint8Array) => void,
    finalize: (outcome: StreamOutcome, stage: StreamStage, error?: unknown) => void,
    setAbortListener: (listener: () => void) => void,
    platform: NodeJS.Platform,
  ): Response {
    const [clientBody, lifecycleBody] = response.body!.tee();
    const reader = lifecycleBody.getReader();
    const listener = () => {
      void Promise.allSettled([
        reader.cancel(abort.signal.reason),
        clientBody.cancel(abort.signal.reason),
      ]).finally(() => {
        finalize("aborted", "lifecycle", abort.signal.reason);
      });
    };
    setAbortListener(listener);
    abort.signal.addEventListener("abort", listener, { once: true });
    void (async () => {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          observeChunk(chunk.value);
        }
        finalize(abort.signal.aborted ? "aborted" : "upstream_completed", "lifecycle", abort.signal.reason);
      } catch (error) {
        if (!abort.signal.aborted) this.reportFailure(error, "lifecycle", counters, platform);
        finalize(abort.signal.aborted ? "aborted" : "failed", "lifecycle", error);
      }
    })();
    return new Response(clientBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  private reportFailure(
    error: unknown,
    stage: "direct" | "lifecycle",
    counters: StreamCounters,
    platform: NodeJS.Platform = process.platform,
  ): void {
    try {
      this.reportStreamFailure(httpStreamFailureDiagnostic(
        error,
        stage,
        platform,
        counters.chunks,
        counters.bytes,
      ));
    } catch {
      // Diagnostics must never affect the response lifecycle.
    }
  }
}
