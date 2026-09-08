export interface ChatGptWebAdapterErrorOptions {
  status: number;
  errorType: string;
  code: string;
  retryable: boolean;
  retireSession?: boolean;
  cause?: unknown;
}

export class ChatGptWebAdapterError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly retireSession: boolean;

  constructor(message: string, options: ChatGptWebAdapterErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatGptWebAdapterError";
    this.status = options.status;
    this.errorType = options.errorType;
    this.code = options.code;
    this.retryable = options.retryable;
    this.retireSession = options.retireSession === true;
  }
}

// Only the compaction owner may signal this after the broker accepts its one-shot handoff.
// It cancels browser observation while preserving the accepted summary as the native result.
export class ChatGptCompactionHandoffAccepted extends DOMException {
  constructor() {
    super("Structured compaction handoff accepted", "AbortError");
  }
}

export function chatGptWebSurfaceError(message: string, streamed: boolean): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(message, {
    status: 502,
    errorType: "server_error",
    code: "chatgpt_surface_changed",
    retryable: !streamed,
    retireSession: true,
  });
}

export function chatGptCompletionEvidenceError(
  message: string,
  streamed: boolean,
): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(message, {
    status: 502,
    errorType: "server_error",
    code: "chatgpt_completion_evidence_missing",
    retryable: !streamed,
    // The page may still be healthy. BrowserWorker asks the canonical session owner whether a
    // same-conversation replacement is safe before the adapter retires this surface.
    retireSession: false,
  });
}

export function chatGptSessionFailureDisposition(error: unknown): "replay" | "retire" {
  return error instanceof ChatGptWebAdapterError && !error.retryable && !error.retireSession
    ? "replay"
    : "retire";
}

export function chatGptBrowserTabClosedError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The ChatGPT browser tab was closed, so the Codex turn was cancelled.",
    {
      status: 499,
      errorType: "client_closed_request",
      code: "client_cancelled",
      retryable: false,
    },
  );
}

export function chatGptStoppedThinkingError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT displayed 'Stopped thinking' and could not continue this response. "
    + "A ChatGPT Web usage limit may have been reached. Check the ChatGPT tab for the exact reason before retrying.",
    {
      status: 502,
      errorType: "server_error",
      code: "chatgpt_stopped_thinking",
      retryable: false,
    },
  );
}
