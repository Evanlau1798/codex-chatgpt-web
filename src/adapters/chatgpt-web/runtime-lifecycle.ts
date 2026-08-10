import { defaultBrokerEndpoint, resolveBrokerEndpoint } from "../../config";
import type { CodexParsedRequest, CodexProviderConfig } from "../../types";
import { ChatGptWebAdapterError } from "./adapter-error";
import { codexToolResultsById } from "./compaction-handoff";
import type { ChatGptTurnSession } from "./turn-execution";

export function brokerSocketPath(provider: CodexProviderConfig): string {
  const configured = provider.chatgptWeb?.brokerSocketPath?.trim();
  return resolveBrokerEndpoint(configured || defaultBrokerEndpoint());
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred;
    rejectPromise = rejectDeferred;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function abortError(): DOMException {
  return new DOMException("ChatGPT web turn aborted", "AbortError");
}

export function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolveWait, rejectWait) => {
    const onAbort = () => rejectWait(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolveWait(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        rejectWait(error);
      },
    );
  });
}

export function recoverableToolSurfaceResultCount(
  error: unknown,
  session: ChatGptTurnSession,
  parsed: CodexParsedRequest,
  recoveries: number,
  signal?: AbortSignal,
): number | undefined {
  if (recoveries > 0
    || signal?.aborted
    || session.runtime.mode !== "tools"
    || !(error instanceof ChatGptWebAdapterError)
    || error.code !== "chatgpt_surface_changed"
    || !error.retryable
    || session.runtime.text.value().length > 0) return undefined;
  const outstanding = session.outstanding();
  if (outstanding.length === 0) {
    return parsed.context.messages.filter(message => message.role === "toolResult").length;
  }
  const results = codexToolResultsById(parsed, session);
  return results.size === outstanding.length ? results.size : undefined;
}
