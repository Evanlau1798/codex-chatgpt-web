import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";

const MAX_TRANSCRIPT_TAIL_BYTES = 1024 * 1024;

export interface ClaudeQueuedSteering {
  deliveryId: string;
  occurredAt: number;
  prompt: string;
}

function deliveryId(sessionId: string, timestamp: string, prompt: string): string {
  return createHash("sha256").update(sessionId).update("\0").update(timestamp).update("\0").update(prompt).digest("hex");
}

function queuedCommand(value: Record<string, unknown>, sessionId: string): ClaudeQueuedSteering | undefined {
  if (value.type !== "attachment" || !value.attachment || typeof value.attachment !== "object") return;
  const attachment = value.attachment as Record<string, unknown>;
  if (attachment.type !== "queued_command" || attachment.commandMode !== "prompt") return;
  const prompt = (typeof attachment.prompt === "string"
    ? attachment.prompt
    : Array.isArray(attachment.prompt) ? attachment.prompt.flatMap(item => (
      item && typeof item === "object"
        && (item as Record<string, unknown>).type === "text"
        && typeof (item as Record<string, unknown>).text === "string"
        ? [(item as Record<string, unknown>).text as string]
        : []
    )).join("\n") : "").trim();
  const timestamp = typeof attachment.timestamp === "string" ? attachment.timestamp : value.timestamp;
  const occurredAt = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
  if (!prompt || !Number.isFinite(occurredAt)) return;
  return { deliveryId: deliveryId(sessionId, timestamp as string, prompt), occurredAt, prompt };
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
    if (value.sessionId !== sessionId) continue;
    const attachment = queuedCommand(value, sessionId);
    if (attachment) {
      queued.push(attachment);
      continue;
    }
    if (value.type !== "queue-operation") continue;
    const content = typeof value.content === "string" && value.content.trim() ? value.content : undefined;
    if (value.operation === "enqueue") {
      if (!content || typeof value.timestamp !== "string") continue;
      const occurredAt = Date.parse(value.timestamp);
      if (!Number.isFinite(occurredAt)) continue;
      queued.push({
        deliveryId: deliveryId(sessionId, value.timestamp, content),
        occurredAt,
        prompt: content,
      });
      continue;
    }
    if (value.operation !== "popAll" && value.operation !== "remove" && value.operation !== "dequeue") continue;
    if (value.operation === "popAll" && !content) continue;
    const index = content ? queued.findIndex(item => item.prompt === content) : 0;
    if (index >= 0 && queued.length > 0) queued.splice(index, 1);
  }
  return queued.slice(-32);
}
