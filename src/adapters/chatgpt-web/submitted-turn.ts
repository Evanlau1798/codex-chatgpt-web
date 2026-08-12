import { StallTimeoutError } from "../../stall-timeout";
import { ChatGptWebAdapterError } from "./adapter-error";
import type { ChatGptTurnSession } from "./turn-execution";

function terminalError(error: unknown): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `ChatGPT failed after accepting the Web prompt: ${error instanceof Error ? error.message : String(error)}`,
    { status: 502, errorType: "server_error", code: "chatgpt_submitted_turn_failed", retryable: false },
  );
}

function submittedFailure(
  session: ChatGptTurnSession,
  aborted: boolean,
  error: unknown,
): ChatGptWebAdapterError | undefined {
  if (aborted || !session.runtime.submission?.accepted) return undefined;
  const terminal = terminalError(error);
  session.setTerminalError(terminal);
  return terminal;
}

export function submittedBrowserFailure(
  session: ChatGptTurnSession,
  aborted: boolean,
  error: unknown,
): ChatGptWebAdapterError | undefined {
  return submittedFailure(session, aborted, error);
}

export function submittedStallFailure(
  session: ChatGptTurnSession,
  aborted: boolean,
  error: unknown,
): ChatGptWebAdapterError | undefined {
  return error instanceof StallTimeoutError ? submittedFailure(session, aborted, error) : undefined;
}
