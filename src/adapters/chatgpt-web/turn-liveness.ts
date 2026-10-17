import type { ChatGptExternalTurnProgressSnapshot } from "./turn-progress";

/** Diagnostic sampling only; never supplies progress, completion or a new deadline. */
export class ChatGptTurnLiveness {
  private readonly startedAt: number;
  private submittedAt?: number;
  private progressAt?: number;
  private generationAt?: number;
  private heartbeatAt?: number;
  private reportedAt?: number;
  private warnedAt?: number;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.startedAt = now();
  }

  submitted(): void { this.submittedAt ??= this.now(); }
  progress(): void { this.progressAt = this.now(); }
  generation(): void { this.generationAt = this.now(); }

  heartbeat(progress?: ChatGptExternalTurnProgressSnapshot, wallNow = Date.now()) {
    const now = this.now();
    const age = (at?: number) => at === undefined ? null : Math.max(0, Math.round(now - at));
    const elapsedMs = age(this.startedAt)!;
    const heartbeatGapMs = age(this.heartbeatAt);
    this.heartbeatAt = now;
    const warning = elapsedMs >= 600_000 && (this.warnedAt === undefined || now - this.warnedAt >= 600_000);
    if (!warning && this.reportedAt !== undefined && now - this.reportedAt < 60_000) return;
    this.reportedAt = now;
    if (warning) this.warnedAt = now;
    return {
      level: warning ? "warn" as const : "info" as const,
      timing: {
        elapsedMs, submittedAgeMs: age(this.submittedAt), heartbeatGapMs,
        outputProgressAgeMs: age(this.progressAt), generationSignalAgeMs: age(this.generationAt),
        nativeProgressAgeMs: progress?.lastProgressAt === undefined ? null : Math.max(0, wallNow - progress.lastProgressAt),
        activeToolCalls: progress?.activeToolCalls ?? 0,
        longRunning: warning,
      },
    };
  }
}
