export interface ChatGptWebAdapterErrorOptions {
  status: number;
  errorType: string;
  code: string;
  retryable: boolean;
  retireSession?: boolean;
}

export class ChatGptWebAdapterError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly retireSession: boolean;

  constructor(message: string, options: ChatGptWebAdapterErrorOptions) {
    super(message);
    this.name = "ChatGptWebAdapterError";
    this.status = options.status;
    this.errorType = options.errorType;
    this.code = options.code;
    this.retryable = options.retryable;
    this.retireSession = options.retireSession === true;
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
