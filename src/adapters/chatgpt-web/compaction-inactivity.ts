import { ChatGptWebAdapterError } from "./adapter-error";
import { chatGptSuspensionClock, remainingStageBudgetMs } from "./browser-stage-lifecycle";
import type { ChatGptTraceFeed } from "./turn-feeds";

/** Compaction observes real progress, never the worker's ownership-only heartbeat. */
export function withCompactionInactivity<T>(
  work: Promise<T>,
  trace: Pick<ChatGptTraceFeed, "observeProgress">,
  timeoutMs: number,
  onTimeout: (error: Error) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    const arm = () => {
      clearTimeout(timer);
      const activityAt = performance.now();
      const suspendedAt = chatGptSuspensionClock.suspendedMs();
      const fire = () => {
        const remaining = remainingStageBudgetMs(timeoutMs, performance.now() - activityAt,
          chatGptSuspensionClock.suspendedMs() - suspendedAt);
        if (remaining > 0) { timer = setTimeout(fire, remaining); timer.unref?.(); return; }
        const error = new ChatGptWebAdapterError(`ChatGPT compaction had no observed activity for ${timeoutMs}ms`, {
          status: 409, errorType: "invalid_request_error", code: "compaction_handoff_timeout", retryable: false,
        });
        reject(error);
        onTimeout(error);
      };
      timer = setTimeout(fire, timeoutMs);
      timer.unref?.();
    };
    stop = trace.observeProgress(arm);
    arm();
  });
  return Promise.race([work, deadline]).finally(() => { clearTimeout(timer); stop?.(); });
}
