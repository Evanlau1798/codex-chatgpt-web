export interface HttpStreamFailureDiagnostic {
  stage: "direct" | "lifecycle";
  platform: NodeJS.Platform;
  chunks: number;
  bytes: number;
  errorName: string;
  errorCode: string;
}

export type HttpStreamFailureReporter = (failure: HttpStreamFailureDiagnostic) => void;

function safeErrorField(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : fallback;
}

export function httpStreamFailureDiagnostic(
  error: unknown,
  stage: HttpStreamFailureDiagnostic["stage"],
  platform: NodeJS.Platform,
  chunks: number,
  bytes: number,
): HttpStreamFailureDiagnostic {
  const candidate = error && typeof error === "object"
    ? error as { name?: unknown; code?: unknown }
    : {};
  return {
    stage,
    platform,
    chunks,
    bytes,
    errorName: safeErrorField(candidate.name, "Error"),
    errorCode: safeErrorField(candidate.code, "unknown"),
  };
}

export const reportHttpStreamFailure: HttpStreamFailureReporter = failure => {
  console.warn(`[http-stream] tracked response failed ${JSON.stringify(failure)}`);
};
