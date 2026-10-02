import { createHash } from "node:crypto";

export interface McpRequestExtra {
  sessionId?: string;
  requestId: string | number;
  _meta?: unknown;
  requestInfo?: unknown;
  signal?: AbortSignal;
}

export function scopeHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function requestScopeSummary(extra: McpRequestExtra): string {
  const meta = extra._meta && typeof extra._meta === "object" && !Array.isArray(extra._meta)
    ? Object.entries(extra._meta as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({
        key,
        type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
        ...(typeof value === "string" ? { chars: value.length, hash: scopeHash(value) } : {}),
      }))
    : [];
  const requestInfoKeys = extra.requestInfo && typeof extra.requestInfo === "object"
    ? Object.keys(extra.requestInfo as Record<string, unknown>).sort()
    : [];
  return JSON.stringify({
    requestId: String(extra.requestId),
    session: extra.sessionId ? { chars: extra.sessionId.length, hash: scopeHash(extra.sessionId) } : null,
    meta,
    requestInfoKeys,
  });
}

export function logMcpToolPhase(
  toolName: string,
  phase: "claim" | "invoke",
  status: "started" | "completed" | "failed",
  detail = "",
): void {
  console.error(`[chatgpt-web-mcp] tool=${toolName} phase=${phase} status=${status}${detail}`);
}

export function diagnosticErrorType(value: unknown): string {
  return value instanceof Error ? value.name : typeof value;
}

/** Stable cause classes only; never log tool arguments, error messages, or tokens. */
export function diagnosticErrorCode(value: unknown): string {
  if (!(value instanceof Error)) return "unknown";
  const message = value.message;
  if (message === "This Codex turn did not advertise deferred tool search") return "deferred_search_unavailable";
  if (message === "Codex deferred tool search query is empty") return "deferred_search_empty";
  if (message.includes("work tools are closed during final-answer recovery")) return "work_tools_closed";
  if (message.includes("already finished") || message.includes("binding was revoked")) return "binding_retired";
  if (message.includes("Read and verify the complete Codex context archive")) return "context_archive_unread";
  if (message.includes("tool is not available in this turn") || message.includes("did not advertise")) return "tool_unavailable";
  if (value.name === "TurnBrokerTimeoutError") return "broker_timeout";
  if (value.name === "AbortError") return "cancelled";
  return "unclassified";
}
