export const CHATGPT_NATIVE_TOOL_PULSE_INTERVAL_MS = 120_000;
export const CHATGPT_NATIVE_TOOL_ABSENCE_GRACE_MS = 5_000;
export const CHATGPT_NATIVE_TOOL_MAX_ACTIVITY_MS = 15 * 60_000;

export type ChatGptNativeToolKind = "web_search" | "native_tool";
export type ChatGptNativeToolEvidence = "streaming_busy" | "running_animation";

export interface ChatGptNativeToolCandidate {
  kind: ChatGptNativeToolKind;
  withinStreamingStatus: boolean;
  ancestorsVisible: boolean;
  ariaBusy: boolean;
  runningFiniteAnimation: boolean;
}

export interface ChatGptNativeToolActivity {
  kind: ChatGptNativeToolKind;
  evidence: ChatGptNativeToolEvidence;
}

export type ChatGptNativeToolActivityEvent =
  | ({ state: "active" } & ChatGptNativeToolActivity)
  | {
    state: "inactive";
    reason: "dom_absent" | "generation_stopped" | "activity_changed" | "lease_ceiling";
  };

export function classifyChatGptNativeToolActivity(
  candidates: ChatGptNativeToolCandidate[],
): ChatGptNativeToolActivity | undefined {
  for (const candidate of candidates) {
    if (!candidate.withinStreamingStatus || !candidate.ancestorsVisible) continue;
    if (candidate.ariaBusy) return { kind: candidate.kind, evidence: "streaming_busy" };
    if (candidate.runningFiniteAnimation) {
      return { kind: candidate.kind, evidence: "running_animation" };
    }
  }
  return undefined;
}

interface ChatGptNativeToolActivityTrackerOptions {
  pulseIntervalMs?: number;
  absenceGraceMs?: number;
  maxActivityMs?: number;
}

interface ActiveLease {
  activity: ChatGptNativeToolActivity;
  key: string;
  startedAt: number;
  lastPulseAt: number;
}

const activityKey = (activity: ChatGptNativeToolActivity): string => (
  `${activity.kind}:${activity.evidence}`
);

export class ChatGptNativeToolActivityTracker {
  private readonly pulseIntervalMs: number;
  private readonly absenceGraceMs: number;
  private readonly maxActivityMs: number;
  private active?: ActiveLease;
  private blockedKey?: string;
  private absentSince?: number;

  constructor(options: ChatGptNativeToolActivityTrackerOptions = {}) {
    this.pulseIntervalMs = options.pulseIntervalMs ?? CHATGPT_NATIVE_TOOL_PULSE_INTERVAL_MS;
    this.absenceGraceMs = options.absenceGraceMs ?? CHATGPT_NATIVE_TOOL_ABSENCE_GRACE_MS;
    this.maxActivityMs = options.maxActivityMs ?? CHATGPT_NATIVE_TOOL_MAX_ACTIVITY_MS;
  }

  update(
    activity: ChatGptNativeToolActivity | undefined,
    generationRunning: boolean,
    now = Date.now(),
  ): ChatGptNativeToolActivityEvent[] {
    if (!generationRunning) {
      const events: ChatGptNativeToolActivityEvent[] = this.active
        ? [{ state: "inactive", reason: "generation_stopped" }]
        : [];
      this.reset();
      return events;
    }

    if (!activity) return this.observeAbsence(now);
    this.absentSince = undefined;
    const key = activityKey(activity);
    if (this.blockedKey === key) return [];
    if (this.blockedKey !== undefined) this.blockedKey = undefined;

    const events: ChatGptNativeToolActivityEvent[] = [];
    if (this.active && this.active.key !== key) {
      events.push({ state: "inactive", reason: "activity_changed" });
      this.active = undefined;
    }
    if (!this.active) {
      this.active = { activity, key, startedAt: now, lastPulseAt: now };
      events.push({ state: "active", ...activity });
      return events;
    }
    if (now - this.active.startedAt >= this.maxActivityMs) {
      events.push({ state: "inactive", reason: "lease_ceiling" });
      this.active = undefined;
      this.blockedKey = key;
      return events;
    }
    if (now - this.active.lastPulseAt >= this.pulseIntervalMs) {
      this.active.lastPulseAt = now;
      events.push({ state: "active", ...activity });
    }
    return events;
  }

  private observeAbsence(now: number): ChatGptNativeToolActivityEvent[] {
    this.absentSince ??= now;
    if (now - this.absentSince < this.absenceGraceMs) return [];
    const events: ChatGptNativeToolActivityEvent[] = this.active
      ? [{ state: "inactive", reason: "dom_absent" }]
      : [];
    this.active = undefined;
    this.blockedKey = undefined;
    return events;
  }

  private reset(): void {
    this.active = undefined;
    this.blockedKey = undefined;
    this.absentSince = undefined;
  }
}

export function formatChatGptNativeToolActivityTelemetry(
  traceId: string,
  event: ChatGptNativeToolActivityEvent,
): string {
  if (event.state === "active") {
    return `[chatgpt-web] native-tool-activity trace=${traceId} state=active kind=${event.kind} evidence=${event.evidence}`;
  }
  return `[chatgpt-web] native-tool-activity trace=${traceId} state=inactive reason=${event.reason}`;
}
