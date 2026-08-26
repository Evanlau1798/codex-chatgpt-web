export type NativeToolActivity = "web_search" | "native_tool";

export type LifecycleProgressSignal =
  | { kind: "semantic_progress" }
  | { kind: "liveness" }
  | { kind: "native_tool_proof"; activity: NativeToolActivity }
  | { kind: "native_tool_inactive" };

export type LifecycleWatchdogStatus =
  | { timedOut: false }
  | { timedOut: true; reason: "absolute" | "semantic_inactivity" };

export interface LifecycleProgressWatchdogOptions {
  startedAt: number;
  inactivityMs: number;
  absoluteMs: number;
  nativeToolLeaseMs: number;
  nativeToolMaxMs: number;
}

/** Keep live smoke bounded even when a transport remains healthy without semantic progress. */
export class LifecycleProgressWatchdog {
  private readonly absoluteDeadline: number;
  private semanticDeadline: number;
  private nativeActivity?: NativeToolActivity;
  private nativeActivityStartedAt?: number;
  private nativeLeaseDeadline?: number;

  constructor(private readonly options: LifecycleProgressWatchdogOptions) {
    for (const [name, value] of Object.entries(options)) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Lifecycle watchdog ${name} must be a non-negative finite number`);
      }
    }
    if (options.inactivityMs === 0 || options.absoluteMs === 0
      || options.nativeToolLeaseMs === 0 || options.nativeToolMaxMs === 0) {
      throw new Error("Lifecycle watchdog durations must be greater than zero");
    }
    this.absoluteDeadline = options.startedAt + options.absoluteMs;
    this.semanticDeadline = options.startedAt + options.inactivityMs;
  }

  observe(signal: LifecycleProgressSignal, now: number): void {
    if (!Number.isFinite(now)) throw new Error("Lifecycle watchdog observation time must be finite");
    if (signal.kind === "liveness") return;
    if (signal.kind === "semantic_progress") {
      this.semanticDeadline = now + this.options.inactivityMs;
      return;
    }
    if (signal.kind === "native_tool_inactive") {
      this.nativeActivity = undefined;
      this.nativeActivityStartedAt = undefined;
      this.nativeLeaseDeadline = undefined;
      return;
    }
    if (this.nativeActivity !== signal.activity || this.nativeActivityStartedAt === undefined) {
      this.nativeActivity = signal.activity;
      this.nativeActivityStartedAt = now;
    }
    const activityCeiling = this.nativeActivityStartedAt + this.options.nativeToolMaxMs;
    this.nativeLeaseDeadline = Math.min(now + this.options.nativeToolLeaseMs, activityCeiling);
  }

  status(now: number): LifecycleWatchdogStatus {
    if (now >= this.absoluteDeadline) return { timedOut: true, reason: "absolute" };
    const progressDeadline = Math.max(this.semanticDeadline, this.nativeLeaseDeadline ?? 0);
    return now >= progressDeadline
      ? { timedOut: true, reason: "semantic_inactivity" }
      : { timedOut: false };
  }
}
