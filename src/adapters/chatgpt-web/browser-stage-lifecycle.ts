import type { Browser, Page } from "playwright-core";
import { withAbort } from "./runtime-lifecycle";

export class ChatGptSuspensionClock {
  private suspendedTotalMs = 0;
  private lastTickAt = Date.now();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly tickIntervalMs = 1_000,
    private readonly gapThresholdMs = 5_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => this.tick(Date.now()), this.tickIntervalMs);
    this.timer.unref?.();
  }

  tick(now: number): void {
    const gap = now - this.lastTickAt;
    this.lastTickAt = now;
    if (gap >= this.gapThresholdMs) this.suspendedTotalMs += gap - this.tickIntervalMs;
  }

  suspendedMs(): number {
    return this.suspendedTotalMs;
  }
}

export const chatGptSuspensionClock = new ChatGptSuspensionClock();

export function remainingStageBudgetMs(
  timeoutMs: number,
  elapsedMs: number,
  suspendedMs: number,
): number {
  const awakeMs = elapsedMs - suspendedMs;
  return awakeMs >= timeoutMs ? 0 : Math.max(250, timeoutMs - awakeMs);
}

export async function connectAfterClosingBrowserConnection<T>(
  previousConnection: Pick<Browser, "close"> | undefined,
  connect: () => Promise<T>,
): Promise<T> {
  if (previousConnection) await previousConnection.close();
  return connect();
}

export const CHATGPT_MIN_OPERATIONAL_VIEWPORT = Object.freeze({ width: 320, height: 240 });

/** A readiness failure after acquiring the exact launcher-owned target; not permission to resend. */
export class ChatGptViewportReadinessError extends Error {
  constructor(
    readonly kind: "viewport_pending" | "renderer_unresponsive" | "target_closed" | "unknown",
    readonly dimensions?: Readonly<{ width: number; height: number }>,
    cause?: unknown,
  ) {
    super(`ChatGPT browser surface did not expose an operational viewport (${kind})`, { cause });
    this.name = "ChatGptViewportReadinessError";
  }
}

export function isRecoverableChatGptViewportFailure(error: unknown): boolean {
  return error instanceof ChatGptViewportReadinessError
    && (error.kind === "viewport_pending" || error.kind === "renderer_unresponsive");
}

export async function waitForOperationalChatGptViewport(
  page: Page,
  signal?: AbortSignal,
  timeoutMs = 10_000,
): Promise<void> {
  const now = () => performance.now() - chatGptSuspensionClock.suspendedMs();
  const started = now();
  const remaining = () => Math.max(0, timeoutMs - (now() - started));
  let dimensions: { width: number; height: number } | undefined;
  const check = () => {
    signal?.throwIfAborted();
    if (page.isClosed()) throw new ChatGptViewportReadinessError("target_closed");
  };
  for (;;) {
    check();
    if (remaining() <= 0) throw new ChatGptViewportReadinessError(dimensions ? "viewport_pending" : "unknown", dimensions);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // One outstanding read at most. A nonresponsive read is not evidence of zero dimensions.
      const timeout = new Promise<never>((_resolve, reject) => {
        const expire = () => {
          if (remaining() > 0) timer = setTimeout(expire, remaining());
          else reject(new ChatGptViewportReadinessError("renderer_unresponsive"));
        };
        timer = setTimeout(expire, remaining());
      });
      dimensions = await withAbort(Promise.race([
        page.evaluate(() => ({ width: innerWidth, height: innerHeight })), timeout,
      ]), signal);
      check();
      if (remaining() <= 0) throw new ChatGptViewportReadinessError("unknown");
      if (!Number.isFinite(dimensions.width) || !Number.isFinite(dimensions.height)) {
        throw new ChatGptViewportReadinessError("unknown");
      }
      if (dimensions.width >= CHATGPT_MIN_OPERATIONAL_VIEWPORT.width
        && dimensions.height >= CHATGPT_MIN_OPERATIONAL_VIEWPORT.height) return;
    } catch (error) {
      check();
      if (error instanceof ChatGptViewportReadinessError) throw error;
      // Target/transport/identity errors do not become another generic timeout retry.
      throw new ChatGptViewportReadinessError("unknown", undefined, error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (remaining() > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await withAbort(new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(50, remaining())); }), signal);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    }
  }
}
