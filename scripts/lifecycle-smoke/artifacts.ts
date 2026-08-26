import { createHash } from "node:crypto";
import { appendFileSync, chmodSync } from "node:fs";
import { atomicWriteFile } from "../../src/config";

const DEFAULT_MAX_LINE_BYTES = 4 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_JSON_ARTIFACT_BYTES = 1024 * 1024;
const MAX_REDACTED_ITEMS = 100;

type ArtifactSummary = Record<string, unknown>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedJson(value: unknown): string {
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  const bytes = Buffer.byteLength(encoded);
  return bytes <= MAX_JSON_ARTIFACT_BYTES
    ? encoded
    : `${JSON.stringify({ type: "artifact_omitted", bytes, sha256: sha256(encoded) }, null, 2)}\n`;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return { chars: value.length, sha256: sha256(value) };
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 6) return { type: "depth_limit" };
  if (Array.isArray(value)) return {
    items: value.slice(0, MAX_REDACTED_ITEMS).map(item => redactValue(item, depth + 1)),
    omitted: Math.max(0, value.length - MAX_REDACTED_ITEMS),
  };
  if (!value || typeof value !== "object") return { type: typeof value };
  const entries = Object.entries(value).slice(0, MAX_REDACTED_ITEMS).map(([key, field], index) => [
    /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key) ? key : `field_${index}`,
    redactValue(field, depth + 1),
  ]);
  return { ...Object.fromEntries(entries), omitted: Math.max(0, Object.keys(value).length - entries.length) };
}

export function appendLifecycleArtifact(path: string, value: string): void {
  appendFileSync(path, value, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows ACLs are owned by the launcher profile. */ }
}

export function saveLifecycleJson(path: string, value: unknown): void {
  atomicWriteFile(path, boundedJson(value));
}

export function saveRedactedLifecycleJson(path: string, value: unknown): void {
  saveLifecycleJson(path, redactValue(value));
}

export function saveLifecycleContentSummary(path: string, kind: string, value: string): void {
  saveLifecycleJson(path, { type: "content_summary", kind, chars: value.length, bytes: Buffer.byteLength(value), sha256: sha256(value) });
}

export function lifecycleErrorCategory(error: unknown): "RATE_OR_VERIFICATION_LIMIT" | "LIFECYCLE_SMOKE_FAILED" {
  return String(error instanceof Error ? error.message : error).includes("RATE_OR_VERIFICATION_LIMIT")
    ? "RATE_OR_VERIFICATION_LIMIT"
    : "LIFECYCLE_SMOKE_FAILED";
}

function chars(value: unknown): number | undefined {
  return typeof value === "string" ? value.length : undefined;
}

function label(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z][a-zA-Z0-9_./-]{0,63}$/.test(value)
    ? value
    : undefined;
}

function present<T extends ArtifactSummary>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

export class LifecycleArtifactEncoder {
  private writtenBytes = 0;
  private limited = false;

  constructor(private limits: { maxLineBytes?: number; maxTotalBytes?: number } = {}) {}

  encode(summary: ArtifactSummary): string | undefined {
    if (this.limited) return undefined;
    const maxLineBytes = this.limits.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    const maxTotalBytes = this.limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    let value = `${JSON.stringify(summary)}\n`;
    const originalBytes = Buffer.byteLength(value);
    if (originalBytes > maxLineBytes) {
      value = `${JSON.stringify({ type: "record_omitted", bytes: originalBytes })}\n`;
    }
    const bytes = Buffer.byteLength(value);
    if (bytes > maxLineBytes || this.writtenBytes + bytes > maxTotalBytes) {
      this.limited = true;
      const marker = `${JSON.stringify({ type: "artifact_limit_reached" })}\n`;
      const markerBytes = Buffer.byteLength(marker);
      if (markerBytes > maxLineBytes || this.writtenBytes + markerBytes > maxTotalBytes) return undefined;
      this.writtenBytes += markerBytes;
      return marker;
    }
    this.writtenBytes += bytes;
    return value;
  }
}

export function summarizeClaudeRecord(record: Record<string, any>, at: string): ArtifactSummary {
  const blocks = Array.isArray(record.message?.content) ? record.message.content : [];
  const textChars = blocks.reduce((total: number, block: Record<string, unknown>) => (
    total + (block?.type === "text" && typeof block.text === "string" ? block.text.length : 0)
  ), 0);
  return present({
    at,
    type: label(record.type),
    subtype: label(record.subtype),
    eventType: label(record.event?.type),
    isError: typeof record.is_error === "boolean" ? record.is_error : undefined,
    resultChars: chars(record.result),
    textChars: textChars || undefined,
    toolUseCount: blocks.filter((block: Record<string, unknown>) => block?.type === "tool_use").length || undefined,
    toolResultCount: blocks.filter((block: Record<string, unknown>) => block?.type === "tool_result").length || undefined,
  });
}

export function summarizeCodexRpc(message: Record<string, any>, at: string): ArtifactSummary {
  return present({
    at,
    method: label(message.method),
    hasId: message.id !== undefined,
    hasError: message.error !== undefined,
    itemType: label(message.params?.item?.type),
    status: label(message.params?.turn?.status ?? message.params?.status),
    deltaChars: chars(message.params?.delta),
    textChars: chars(message.params?.item?.text),
  });
}

export function summarizeStreamChunk(stream: "stdout" | "stderr", at: string, chars: number): ArtifactSummary {
  return { at, stream, chars };
}
