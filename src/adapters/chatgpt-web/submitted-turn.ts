import { StallTimeoutError } from "../../stall-timeout";
import type { CodexParsedRequest, CodexToolResultMessage } from "../../types";
import { ChatGptWebAdapterError, isChatGptTerminalCompletionFailure } from "./adapter-error";
import type { ChatGptTurnSession } from "./turn-execution";

function terminalError(error: unknown, phase: "send_activated" | "accepted"): ChatGptWebAdapterError {
  const ambiguous = phase === "send_activated";
  return new ChatGptWebAdapterError(
    ambiguous
      ? `ChatGPT Send was activated, but acceptance could not be proven; the prompt will not be resent: ${error instanceof Error ? error.message : String(error)}`
      : `ChatGPT failed after accepting the Web prompt: ${error instanceof Error ? error.message : String(error)}`,
    {
      status: 502,
      errorType: "server_error",
      code: ambiguous ? "chatgpt_submission_ambiguous" : "chatgpt_submitted_turn_failed",
      retryable: false,
    },
  );
}

function submittedFailure(
  session: ChatGptTurnSession,
  aborted: boolean,
  error: unknown,
  parsed?: CodexParsedRequest,
): ChatGptWebAdapterError | undefined {
  const phase = session.runtime.submission?.phase;
  if (error instanceof ChatGptWebAdapterError && error.code === "chatgpt_delivery_timeout"
    && session.runtime.mode === "tools") {
    if (!error.retryable) {
      session.setTerminalError(error);
      return error;
    }
    const results = parsed?.context.messages.filter((message): message is CodexToolResultMessage =>
      message.role === "toolResult" && session.hasOutstanding(message.toolCallId)) ?? [];
    const returnedIds = new Set(results.map(result => result.toolCallId));
    const unresolved = session.outstanding().some(call => !returnedIds.has(call.callId))
      || (session.runtime.externalProgress?.snapshot().activeToolCalls ?? 0) > returnedIds.size
      || results.length !== returnedIds.size;
    if (unresolved) {
      const pending = new ChatGptWebAdapterError(
        "ChatGPT reported that message delivery timed out while a tool result was still pending. "
        + "Check the running command and its result before continuing.",
        { status: error.status, errorType: error.errorType, code: error.code, retryable: false, cause: error },
      );
      session.setTerminalError(pending);
      return pending;
    }
    const canonicalResults = parsed?.context.messages.filter((message): message is CodexToolResultMessage =>
      message.role === "toolResult") ?? [];
    const canonicalIds = new Set(canonicalResults.map(result => result.toolCallId));
    const canonicalCallsComplete = canonicalResults.length > 0 && canonicalResults.length === canonicalIds.size
      && !parsed?.context.messages.some(message => message.role === "assistant"
        && message.content.some(part => part.type === "toolCall" && !canonicalIds.has(part.id)));
    // Canonical results prove completion without sending anything to the retired binding.
    // Every other accepted or ambiguous failure keeps its existing terminal receipt.
    if (phase === "accepted" && error.retryable && !aborted && parsed?._canonicalContextComplete === true
      && session.canonicalCallDiagnostics().complete && session.unresolvedSupersededResultIds().length === 0
      && (results.length > 0 || session.completedToolResultCount() > 0)
      && canonicalCallsComplete
      && !session.runtime.manualControl && !session.runtime.compactionRequested && !parsed._compactionRequest
      && session.runtime.text.value().length === 0) return error;
  }
  if (!phase || phase === "prepared") return undefined;
  const terminal = error instanceof ChatGptWebAdapterError && !error.retryable
    && (session.runtime.manualControl
      || error.retireSession
      || error.code === "chatgpt_submission_ambiguous"
      || error.code === "chatgpt_response_incomplete"
      || isChatGptTerminalCompletionFailure(error)
      || error.code === "chatgpt_stopped_thinking"
      || error.code === "context_length_exceeded"
      || error.code === "compaction_handoff_timeout"
      || error.code === "chatgpt_tool_approval_required"
      || error.code === "codex_tool_timeout"
      || error.code === "chatgpt_submitted_turn_failed")
    ? error
    : terminalError(error, phase);
  session.setTerminalError(terminal);
  return terminal;
}

export function submittedBrowserFailure(
  session: ChatGptTurnSession,
  aborted: boolean,
  error: unknown,
  parsed?: CodexParsedRequest,
): ChatGptWebAdapterError | undefined {
  return submittedFailure(session, aborted, error, parsed);
}

export function submittedStallFailure(
  session: ChatGptTurnSession,
  aborted: boolean,
  error: unknown,
  parsed?: CodexParsedRequest,
): ChatGptWebAdapterError | undefined {
  if (error instanceof StallTimeoutError) {
    const settled = session.settledOutcome();
    if (settled?.type === "error" && settled.error instanceof ChatGptWebAdapterError
      && settled.error.code === "chatgpt_delivery_timeout") error = settled.error;
    return submittedFailure(session, aborted, error, parsed);
  }
  return error instanceof ChatGptWebAdapterError && error.code === "chatgpt_delivery_timeout"
    ? submittedFailure(session, aborted, error, parsed) : undefined;
}
