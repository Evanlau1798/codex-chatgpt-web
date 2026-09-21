import type { ChatGptPromptInsertionPlan } from "./prompt-insertion-plan";

export type ChatGptPromptPhase = "insert" | "verify" | "boundary_restore" | "markdown_restore" | "reanchor" | "final_verify";
export interface ChatGptNativeEditResult<T> { result: T; attempts: number; accepted: number }
export interface ChatGptPromptInsertionSnapshot {
  plan: ChatGptPromptInsertionPlan;
  phase: ChatGptPromptPhase;
  event: "started" | "completed" | "failed" | "progress" | "summary";
  phaseElapsedMs: number;
  totalElapsedMs: number;
  actualChunks: number;
  insertedUtf16Units: number;
  verifiedUtf16Units: number;
  editEvaluationsStarted: number;
  editEvaluationsSettled: number;
  nativeEditAttempts: number;
  nativeEditAccepted: number;
  nativeEditCountsComplete: boolean;
  restorationBatches: number;
  remainingMarkers: number;
}

/** One insertion's counters. No prompt, DOM, error body, hash, or per-marker logging. */
export class ChatGptPromptInsertionMetrics {
  private readonly startedAt: number;
  private phaseAt: number;
  private lastProgressAt = -Infinity;
  private phase: ChatGptPromptPhase = "insert";
  private closed = false;
  private actualChunks = 0;
  private insertedUtf16Units = 0;
  private verifiedUtf16Units = 0;
  private editEvaluationsStarted = 0;
  private editEvaluationsSettled = 0;
  private nativeEditAttempts = 0;
  private nativeEditAccepted = 0;
  private nativeEditCountsComplete = true;
  private restorationBatches = 0;
  private remainingMarkers = 0;

  constructor(readonly plan: ChatGptPromptInsertionPlan,
    private readonly emit?: (snapshot: ChatGptPromptInsertionSnapshot) => void,
    private readonly now: () => number = () => performance.now()) {
    this.phaseAt = this.startedAt = now();
  }

  snapshot(event: ChatGptPromptInsertionSnapshot["event"]): ChatGptPromptInsertionSnapshot {
    const now = this.now();
    return { plan: this.plan, phase: this.phase, event,
      phaseElapsedMs: Math.max(0, Math.round(now - this.phaseAt)),
      totalElapsedMs: Math.max(0, Math.round(now - this.startedAt)),
      actualChunks: this.actualChunks, insertedUtf16Units: this.insertedUtf16Units,
      verifiedUtf16Units: this.verifiedUtf16Units, editEvaluationsStarted: this.editEvaluationsStarted,
      editEvaluationsSettled: this.editEvaluationsSettled, nativeEditAttempts: this.nativeEditAttempts,
      nativeEditAccepted: this.nativeEditAccepted,
      nativeEditCountsComplete: this.nativeEditCountsComplete && this.editEvaluationsStarted === this.editEvaluationsSettled,
      restorationBatches: this.restorationBatches, remainingMarkers: this.remainingMarkers };
  }
  private publish(event: ChatGptPromptInsertionSnapshot["event"]): void {
    // Diagnostics must never change whether a prompt is accepted, rejected, or cleaned up.
    try { this.emit?.(this.snapshot(event)); } catch { /* best-effort, content-free telemetry */ }
  }
  async run<T>(phase: ChatGptPromptPhase, action: () => Promise<T>): Promise<T> {
    this.phase = phase; this.phaseAt = this.now(); this.publish("started");
    try { const result = await action(); this.publish("completed"); return result; }
    catch (error) { this.publish("failed"); throw error; }
  }
  finish(): void { if (!this.closed) { this.publish("summary"); this.closed = true; } }
  chunk(): void { if (!this.closed) this.actualChunks += 1; }
  inserted(units: number): void { if (!this.closed) this.insertedUtf16Units = units; }
  verified(units: number): void { if (!this.closed) this.verifiedUtf16Units = units; }
  markers(remaining: number): void {
    if (this.closed) return;
    const decreased = remaining < this.remainingMarkers;
    this.remainingMarkers = remaining;
    if (decreased && this.now() - this.lastProgressAt >= 1_000) {
      this.lastProgressAt = this.now();
      this.publish("progress");
    }
  }
  restorationBatch(): void { if (!this.closed) this.restorationBatches += 1; }
  editStarted(): void { if (!this.closed) this.editEvaluationsStarted += 1; }
  editSettled<T>(value: T | ChatGptNativeEditResult<T>): T {
    const counted = value !== null && typeof value === "object" && "attempts" in value && "accepted" in value && "result" in value;
    if (!this.closed) {
      this.editEvaluationsSettled += 1;
      if (counted) { this.nativeEditAttempts += value.attempts; this.nativeEditAccepted += value.accepted; }
      else this.nativeEditCountsComplete = false; // Legacy test doubles cannot prove native edits.
    }
    return counted ? value.result : value;
  }
}

export function chatGptNativeEditValue<T>(value: T | ChatGptNativeEditResult<T>, metrics?: ChatGptPromptInsertionMetrics): T {
  if (metrics) return metrics.editSettled(value);
  return value !== null && typeof value === "object" && "result" in value ? value.result as T : value as T;
}
