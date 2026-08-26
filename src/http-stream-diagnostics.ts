export interface HttpStreamFailureDiagnostic {
  stage: "direct" | "lifecycle";
  platform: NodeJS.Platform;
  chunks: number;
  bytes: number;
  errorName: string;
  errorCode: string;
}

export type HttpStreamFailureReporter = (failure: HttpStreamFailureDiagnostic) => void;

export interface HttpStreamTimingDiagnostic {
  route: string;
  stage: "headers" | "direct" | "lifecycle";
  platform: NodeJS.Platform;
  status: number | null;
  requestId: string | null;
  outcome: "completed" | "upstream_completed" | "cancelled" | "aborted" | "failed";
  headersMs: number;
  firstChunkMs: number | null;
  maxChunkGapMs: number;
  totalMs: number;
  chunks: number;
  bytes: number;
  errorName: string | null;
  errorCode: string | null;
}

export type HttpStreamTimingReporter = (timing: HttpStreamTimingDiagnostic) => void;
export type HttpStreamTimingLevel = "info" | "warning";

const SAFE_ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "AbortError",
  "TimeoutError",
  "DOMException",
  "SystemError",
]);

const SAFE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ENOTFOUND",
  "ABORT_ERR",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function safeDiagnosticIdentifier(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : null;
}

export function safeDiagnosticRoute(value: unknown): string {
  return typeof value === "string" && /^\/[A-Za-z0-9_./-]{1,127}$/.test(value) ? value : "unknown";
}

export function safeErrorMetadata(error: unknown): { errorName: string; errorCode: string } {
  const candidate = error && typeof error === "object"
    ? error as { name?: unknown; code?: unknown }
    : {};
  const name = typeof candidate.name === "string" ? candidate.name : undefined;
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  return {
    errorName: name && SAFE_ERROR_NAMES.has(name) ? name : "Error",
    errorCode: code && SAFE_ERROR_CODES.has(code) ? code : "unknown",
  };
}

export function httpStreamFailureDiagnostic(
  error: unknown,
  stage: HttpStreamFailureDiagnostic["stage"],
  platform: NodeJS.Platform,
  chunks: number,
  bytes: number,
): HttpStreamFailureDiagnostic {
  const safe = safeErrorMetadata(error);
  return {
    stage,
    platform,
    chunks,
    bytes,
    ...safe,
  };
}

export const reportHttpStreamFailure: HttpStreamFailureReporter = failure => {
  console.warn(`[http-stream] tracked response failed ${JSON.stringify(failure)}`);
};

export function httpStreamTimingLevel(timing: HttpStreamTimingDiagnostic): HttpStreamTimingLevel | null {
  const completed = timing.outcome === "completed" || timing.outcome === "upstream_completed";
  const successfulStatus = timing.status !== null && timing.status >= 200 && timing.status < 300;
  const receivedResponseData = timing.chunks > 0 && timing.firstChunkMs !== null;
  const routineClientClose = successfulStatus
    && receivedResponseData
    && (timing.outcome === "cancelled"
      || (timing.outcome === "aborted" && timing.errorName === "AbortError"));
  const failed = timing.outcome === "failed"
    || timing.status === null
    || timing.status >= 400
    || (!completed && !routineClientClose);
  const severeLatency = timing.headersMs >= 10_000
    || (timing.firstChunkMs !== null && timing.firstChunkMs >= 10_000)
    || timing.maxChunkGapMs >= 30_000
    || timing.totalMs >= 180_000;
  if (failed || severeLatency) return "warning";

  const moderateLatency = timing.headersMs >= 5_000
    || (timing.firstChunkMs !== null && timing.firstChunkMs >= 5_000)
    || timing.maxChunkGapMs >= 5_000
    || timing.totalMs >= 60_000;
  return moderateLatency ? "info" : null;
}

export const reportHttpStreamTiming: HttpStreamTimingReporter = timing => {
  const level = httpStreamTimingLevel(timing);
  if (level === "warning") console.warn(`[http-stream] tracked response timing ${JSON.stringify(timing)}`);
  else if (level === "info") console.info(`[http-stream] tracked response timing ${JSON.stringify(timing)}`);
};
