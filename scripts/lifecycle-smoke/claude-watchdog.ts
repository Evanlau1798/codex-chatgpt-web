export const CLAUDE_RESULT_ABSOLUTE_TIMEOUT_MS = 45 * 60_000;
export const CLAUDE_COMMAND_ABSOLUTE_TIMEOUT_MS = 20 * 60_000;

type ClaudeRecord = Record<string, any>;

export function claudeResultRecordSignalsProgress(record: ClaudeRecord): boolean {
  if (record.type === "assistant" || record.type === "user" || record.type === "result") return true;
  if (record.type === "stream_event") {
    const eventType = String(record.event?.type ?? "");
    return eventType === "content_block_start"
      || eventType === "content_block_delta"
      || eventType === "content_block_stop"
      || eventType === "message_delta"
      || eventType === "message_stop";
  }
  if (record.type === "system") {
    const subtype = String(record.subtype ?? "");
    return subtype === "compact_boundary" || subtype.startsWith("task_");
  }
  return false;
}

export class ClaudeResultWatchdog {
  private inactivityDeadline: number;
  private readonly absoluteDeadline: number;

  constructor(
    startedAt: number,
    private readonly inactivityTimeoutMs: number,
    absoluteTimeoutMs = CLAUDE_RESULT_ABSOLUTE_TIMEOUT_MS,
  ) {
    this.inactivityDeadline = startedAt + inactivityTimeoutMs;
    this.absoluteDeadline = startedAt + absoluteTimeoutMs;
  }

  observe(now: number, records: ClaudeRecord[]): void {
    if (records.some(claudeResultRecordSignalsProgress)) {
      this.inactivityDeadline = now + this.inactivityTimeoutMs;
    }
  }

  deadline(): number {
    return Math.min(this.inactivityDeadline, this.absoluteDeadline);
  }

  expired(now: number): "inactivity" | "absolute" | undefined {
    if (now >= this.absoluteDeadline) return "absolute";
    if (now >= this.inactivityDeadline) return "inactivity";
    return undefined;
  }
}

export async function waitForClaudeCommandExit(
  child: { exited: Promise<number>; kill: (signal?: number) => void },
  timeoutMs = CLAUDE_COMMAND_ABSOLUTE_TIMEOUT_MS,
): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          child.kill(9);
          reject(new Error(`Claude command timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
