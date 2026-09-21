import { ChatGptPersistentBrowserStateError, waitForChatGptMutationPoll } from "../../browser-mutation";
import { ChatGptWebAdapterError } from "./adapter-error";
import { chatGptSuspensionClock } from "./browser-stage-lifecycle";

export class ChatGptPromptDeadlineError extends ChatGptWebAdapterError {
  constructor() {
    super("ChatGPT prompt operation exhausted its remaining readiness budget", {
      status: 502, errorType: "server_error", code: "chatgpt_prompt_attachment_timeout",
      retryable: false, retireSession: true,
    });
    this.name = "ChatGptPromptDeadlineError";
  }
}

/** The current stage's budget is authoritative; nested scopes can only shorten it. */
export class ChatGptPromptOperation {
  constructor(readonly signal?: AbortSignal,
    private readonly remaining: () => number = () => Number.POSITIVE_INFINITY,
    readonly now: () => number = () => performance.now() - chatGptSuspensionClock.suspendedMs()) {}

  timeLeft(): number {
    if (this.signal?.aborted) throw this.signal.reason ?? new DOMException("Prompt attachment aborted", "AbortError");
    return Math.max(0, this.remaining());
  }
  check(): void { if (this.timeLeft() <= 0) throw new ChatGptPromptDeadlineError(); }
  budget(timeoutMs: number): ChatGptPromptOperation {
    const start = this.now();
    return new ChatGptPromptOperation(this.signal,
      () => Math.min(this.timeLeft(), timeoutMs - Math.max(0, this.now() - start)), this.now);
  }
  options(capMs = 20_000): { signal?: AbortSignal; timeout: number } {
    this.check();
    return { signal: this.signal, timeout: Math.max(1, Math.ceil(Math.min(capMs, this.timeLeft()))) };
  }

  /** Only read-side waits may detach. Their late values cannot authorize follow-up work. */
  async read<T>(action: (options: { signal?: AbortSignal; timeout: number }) => Promise<T>, capMs = 20_000): Promise<T> {
    const scope = this.budget(capMs);
    scope.check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const expiry = new Promise<never>((_, reject) => {
      const tick = () => {
        try {
          scope.check();
          timer = setTimeout(tick, Math.max(1, scope.timeLeft()));
        } catch (error) { reject(error); }
      };
      onAbort = () => { try { scope.check(); } catch (error) { reject(error); } };
      this.signal?.addEventListener("abort", onAbort, { once: true });
      tick();
    });
    try {
      const result = await Promise.race([action(scope.options(capMs)), expiry]);
      scope.check();
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) this.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Never race an editor mutation. The stage owner settles it or retires its surface. */
  async mutate<T>(action: (options: { signal?: AbortSignal; timeout: number }) => Promise<T>, capMs = 20_000): Promise<T> {
    const options = this.options(capMs);
    let result: T;
    try { result = await action(options); }
    catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || (error.name === "AbortError" && this.signal?.aborted))) {
        // A transport timeout/cancel is not proof that the renderer stopped mutating.
        throw new ChatGptPersistentBrowserStateError([error], "ChatGPT editor mutation settlement could not be confirmed");
      }
      throw error;
    }
    this.check();
    return result;
  }

  async poll(ms: number): Promise<void> {
    this.check();
    await waitForChatGptMutationPoll(Math.min(ms, this.timeLeft()), this.signal);
    if (this.signal?.aborted) this.check();
    // The caller distinguishes a finished settling window from its parent stage expiring.
  }
}
