import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";

const MAX_TRANSCRIPT_TAIL_BYTES = 1024 * 1024;

export interface ClaudeQueuedSteering {
  deliveryId: string;
  occurredAt: number;
  prompt: string;
}

function transcriptTail(path: string): string {
  const size = statSync(path).size;
  const length = Math.min(size, MAX_TRANSCRIPT_TAIL_BYTES);
  const start = size - length;
  const buffer = Buffer.allocUnsafe(length);
  const fd = openSync(path, "r");
  let read = 0;
  try {
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, start + read);
      if (count === 0) break;
      read += count;
    }
  } finally {
    closeSync(fd);
  }
  const text = buffer.subarray(0, read).toString("utf8");
  if (start === 0) return text.replace(/^\uFEFF/, "");
  const boundary = text.indexOf("\n");
  return boundary < 0 ? "" : text.slice(boundary + 1);
}

export function readClaudeQueuedSteering(path: string, sessionId: string): ClaudeQueuedSteering[] {
  if (basename(path) !== `${sessionId}.jsonl`) return [];
  const queued: ClaudeQueuedSteering[] = [];
  for (const line of transcriptTail(path).split(/\r?\n/)) {
    if (!line) continue;
    let value: Record<string, unknown>;
    try { value = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }
    if (value.type !== "queue-operation" || value.operation !== "enqueue"
      || value.sessionId !== sessionId || typeof value.content !== "string" || !value.content.trim()
      || typeof value.timestamp !== "string") continue;
    const occurredAt = Date.parse(value.timestamp);
    if (!Number.isFinite(occurredAt)) continue;
    queued.push({
      deliveryId: createHash("sha256").update(line).digest("hex"),
      occurredAt,
      prompt: value.content,
    });
  }
  return queued.slice(-32);
}
