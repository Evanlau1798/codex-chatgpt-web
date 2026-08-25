import { defaultBrokerEndpoint, resolveBrokerEndpoint } from "../../config";
import type { CodexParsedRequest, CodexProviderConfig } from "../../types";
import { StallTimeoutError } from "../../stall-timeout";
import { ChatGptWebAdapterError } from "./adapter-error";
import { codexToolResultsById } from "./compaction-handoff";
import { chatGptErrorDiagnosticIdentity } from "./preparation-diagnostics";
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

export type ChatGptSurfaceRecoveryReason =
  | "eligible"
  | "already_recovered"
  | "aborted"
  | "read_only"
  | "unsupported_error"
  | "non_retryable"
  | "submission_activated"
  | "final_streamed"
  | "canonical_incomplete"
  | "superseded_results_pending"
  | "tool_results_incomplete";

export interface ChatGptSurfaceRecoveryDecision {
  eligible: boolean;
  reason: ChatGptSurfaceRecoveryReason;
  canonicalResultCount: number;
  unresolvedSupersededCount: number;
}

export type ChatGptSameSurfaceRecoveryReason =
  | "eligible"
  | "mode_disabled"
  | "already_recovered"
  | "aborted"
  | "unsupported_error"
  | "non_retryable"
  | "final_streamed"
  | "canonical_incomplete"
  | "superseded_results_pending"
  | "tool_results_pending";

export interface ChatGptSameSurfaceRecoveryDecision {
  eligible: boolean;
  reason: ChatGptSameSurfaceRecoveryReason;
  outstandingCount: number;
  unresolvedSupersededCount: number;
}

export const CHATGPT_SAME_SURFACE_RECOVERY_PROMPT = [
  "Continue the current task from the work already completed in this conversation.",
  "Do not repeat completed tool calls.",
  "Finish any remaining work and provide the final response.",
].join(" ");

export function chatGptSameSurfaceRecoveryDecision(
  error: unknown,
  session: ChatGptTurnSession,
  attempt: number,
  enhancedMode: boolean,
  signal?: AbortSignal,
): ChatGptSameSurfaceRecoveryDecision {
  const outstandingCount = session.outstanding().length;
  const unresolvedSupersededCount = session.unresolvedSupersededResultIds().length;
  const reject = (
    reason: Exclude<ChatGptSameSurfaceRecoveryReason, "eligible">,
  ): ChatGptSameSurfaceRecoveryDecision => ({
    eligible: false,
    reason,
    outstandingCount,
    unresolvedSupersededCount,
  });
  if (!enhancedMode) return reject("mode_disabled");
  if (attempt > 1) return reject("already_recovered");
  if (signal?.aborted) return reject("aborted");
  if (!(error instanceof ChatGptWebAdapterError)
    || error.code !== "chatgpt_completion_evidence_missing") return reject("unsupported_error");
  if (!error.retryable) return reject("non_retryable");
  if (session.runtime.text.value().length > 0) return reject("final_streamed");
  const canonical = session.canonicalCallDiagnostics();
  if (!canonical.complete) return reject("canonical_incomplete");
  if (unresolvedSupersededCount > 0) return reject("superseded_results_pending");
  if (outstandingCount > 0) return reject("tool_results_pending");
  return { eligible: true, reason: "eligible", outstandingCount, unresolvedSupersededCount };
}

export function chatGptSurfaceRecoveryDecision(
  error: unknown,
  session: ChatGptTurnSession,
  parsed: CodexParsedRequest,
  recoveries: number,
  signal?: AbortSignal,
): ChatGptSurfaceRecoveryDecision {
  const canonicalResultCount = parsed.context.messages.filter(message => message.role === "toolResult").length;
  const unresolvedSupersededCount = session.unresolvedSupersededResultIds().length;
  const reject = (reason: Exclude<ChatGptSurfaceRecoveryReason, "eligible">): ChatGptSurfaceRecoveryDecision => ({
    eligible: false,
    reason,
    canonicalResultCount,
    unresolvedSupersededCount,
  });
  if (recoveries > 0) return reject("already_recovered");
  if (signal?.aborted) return reject("aborted");
  if (session.runtime.mode !== "tools") return reject("read_only");
  if (session.runtime.submission?.phase === "send_activated") return reject("submission_activated");
  const surfaceFailure = error instanceof ChatGptWebAdapterError
    && (error.code === "chatgpt_surface_changed"
      || error.code === "chatgpt_connector_unavailable"
      || error.code === "chatgpt_completion_evidence_missing");
  if (!surfaceFailure && !(error instanceof StallTimeoutError)) {
    return reject("unsupported_error");
  }
  if (surfaceFailure && !error.retryable) return reject("non_retryable");
  if (session.runtime.text.value().length > 0) return reject("final_streamed");
  if (parsed._canonicalContextComplete !== true) return reject("canonical_incomplete");
  if (unresolvedSupersededCount > 0) return reject("superseded_results_pending");
  const outstanding = session.outstanding();
  if (outstanding.length === 0) {
    return { eligible: true, reason: "eligible", canonicalResultCount, unresolvedSupersededCount };
  }
  const results = codexToolResultsById(parsed, session);
  if (results.size !== outstanding.length) return reject("tool_results_incomplete");
  return {
    eligible: true,
    reason: "eligible",
    canonicalResultCount: results.size,
    unresolvedSupersededCount,
  };
}

export class ChatGptSurfaceRecoveryTracker {
  private diagnosticLogged = false;

  constructor(private readonly traceId: string) {}

  recoverableResultCount(
    error: unknown,
    session: ChatGptTurnSession,
    parsed: CodexParsedRequest,
    recoveries: number,
    signal?: AbortSignal,
  ): number | undefined {
    const decision = chatGptSurfaceRecoveryDecision(error, session, parsed, recoveries, signal);
    if (!this.diagnosticLogged) {
      this.diagnosticLogged = true;
      const canonical = session.canonicalCallDiagnostics();
      console.warn(
        `[chatgpt-web] browser turn ${this.traceId} surface recovery eligible=${decision.eligible}`
        + ` reason=${decision.reason} ${chatGptErrorDiagnosticIdentity(error)} generation=${recoveries}`
        + ` finalChars=${session.runtime.text.value().length}`
        + ` canonicalResults=${decision.canonicalResultCount}`
        + ` unresolvedSuperseded=${decision.unresolvedSupersededCount}`
        + ` canonicalGeneration=${canonical.generation} canonicalComplete=${canonical.complete}`
        + ` canonicalCalls=${canonical.calls} cancelledBeforeCanonical=${canonical.cancelledBeforeCanonical}`
        + ` resolvedSuperseded=${canonical.resolvedSuperseded}`,
      );
    }
    return decision.eligible ? decision.canonicalResultCount : undefined;
  }
}
