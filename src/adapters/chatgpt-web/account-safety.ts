import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../../config";

export type ChatGptAccountSafetyState = "NORMAL" | "DRAINING" | "PAUSED" | "HARD_STOP";
export type ChatGptAccountSafetyReason = "duration_limit" | "rate_limit" | "account_security";
export const DEFAULT_CHATGPT_AUTOMATIC_WEB_SESSION_LIMIT = 15;

export const CHATGPT_ACCOUNT_SAFETY_DRAIN_PROMPT =
  "The local Automatic Web safety budget has been reached. Do not start new work, spawn new agents, or expand scope. "
  + "Finish only the minimum steps needed to leave the current work in a consistent state, summarize completed work, "
  + "remaining work, and verification status, then end this turn.";

interface PersistedSafetyState {
  version: 1;
  state: ChatGptAccountSafetyState;
  reason?: ChatGptAccountSafetyReason;
  windowStartedAt?: number;
  sessionUsages?: Array<{ id: string; usedAt: number }>;
  /** Legacy fixed-window state written by the first local implementation. */
  sessionIds?: string[];
  capturedTraceIds?: string[];
  steeredTraceIds?: string[];
}

function validPersistedSafetyState(value: unknown): PersistedSafetyState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const parsed = value as Partial<PersistedSafetyState> & Record<string, unknown>;
  if (parsed.version !== 1
    || !["NORMAL", "DRAINING", "PAUSED", "HARD_STOP"].includes(String(parsed.state ?? ""))) return undefined;
  if (parsed.windowStartedAt !== undefined
    && (!Number.isSafeInteger(parsed.windowStartedAt) || (parsed.windowStartedAt as number) < 0)) return undefined;
  if (parsed.reason !== undefined
    && parsed.reason !== "duration_limit" && parsed.reason !== "rate_limit" && parsed.reason !== "account_security") return undefined;
  const validIds = (ids: unknown): ids is string[] => Array.isArray(ids)
    && ids.every(id => typeof id === "string" && id.length > 0)
    && new Set(ids).size === ids.length;
  if (parsed.capturedTraceIds !== undefined && !validIds(parsed.capturedTraceIds)) return undefined;
  if (parsed.steeredTraceIds !== undefined && !validIds(parsed.steeredTraceIds)) return undefined;
  if (parsed.sessionIds !== undefined && (!validIds(parsed.sessionIds) || parsed.sessionIds.length > 10_000)) return undefined;
  const validSessionUsages = (usages: unknown): usages is Array<{ id: string; usedAt: number }> => Array.isArray(usages)
    && usages.length <= 10_000
    && usages.every(usage => usage && typeof usage === "object" && !Array.isArray(usage)
      && typeof (usage as { id?: unknown }).id === "string" && (usage as { id: string }).id.length > 0
      && Number.isSafeInteger((usage as { usedAt?: unknown }).usedAt) && (usage as { usedAt: number }).usedAt >= 0)
    && new Set(usages.map(usage => usage.id)).size === usages.length;
  if (parsed.sessionUsages !== undefined && !validSessionUsages(parsed.sessionUsages)) return undefined;
  if (parsed.sessionIds !== undefined && parsed.sessionUsages !== undefined) return undefined;
  if ((parsed.sessionIds?.length || parsed.sessionUsages?.length) && parsed.windowStartedAt === undefined) return undefined;

  if (parsed.state === "NORMAL") {
    if (parsed.reason !== undefined || parsed.capturedTraceIds !== undefined || parsed.steeredTraceIds !== undefined) return undefined;
  } else if (parsed.state === "DRAINING") {
    if (parsed.reason === undefined || !parsed.capturedTraceIds?.length || parsed.steeredTraceIds === undefined
      || parsed.steeredTraceIds.some(traceId => !parsed.capturedTraceIds!.includes(traceId))) return undefined;
  } else if (parsed.state === "PAUSED") {
    if ((parsed.reason !== "duration_limit" && parsed.reason !== "rate_limit")
      || parsed.capturedTraceIds !== undefined || parsed.steeredTraceIds !== undefined) return undefined;
  } else if (parsed.reason !== "account_security"
    || parsed.capturedTraceIds !== undefined || parsed.steeredTraceIds !== undefined) return undefined;
  return parsed as PersistedSafetyState;
}

export interface ChatGptAccountSafetyStatus {
  state: ChatGptAccountSafetyState;
  reason?: ChatGptAccountSafetyReason;
  windowStartedAt?: number;
  remainingMs?: number;
  limitMinutes?: number;
  usedSessions: number;
  sessionLimit?: number;
  capturedTraceIds: string[];
}

export interface ChatGptAccountSafetyAdmission {
  allowed: boolean;
  status: ChatGptAccountSafetyStatus;
  steeringTraceIds: string[];
}

const targetState = (reason: ChatGptAccountSafetyReason): ChatGptAccountSafetyState => (
  reason === "account_security" ? "HARD_STOP" : "PAUSED"
);

export function defaultChatGptAccountSafetyStatePath(): string {
  return join(getConfigDir(), "runtime", "account-safety.json");
}

export class ChatGptAccountSafety {
  private data: PersistedSafetyState;
  private readonly traceRefs = new Map<string, number>();

  constructor(private readonly path = defaultChatGptAccountSafetyStatePath()) {
    this.data = this.load();
    if (this.data.state === "DRAINING") {
      this.data = {
        version: 1,
        state: targetState(this.data.reason ?? "duration_limit"),
        reason: this.data.reason ?? "duration_limit",
        ...(this.data.windowStartedAt !== undefined ? { windowStartedAt: this.data.windowStartedAt } : {}),
        ...(this.data.sessionUsages !== undefined ? { sessionUsages: this.data.sessionUsages } : {}),
      };
      this.persist();
    }
  }

  status(
    limitCount: number | undefined,
    limitMinutes: number | undefined,
    activeTraceIds: readonly string[],
    now = Date.now(),
  ): ChatGptAccountSafetyStatus {
    this.syncUsageWindow(limitCount, limitMinutes, now);
    this.finishDrainIfIdle(activeTraceIds);
    this.syncUsageWindow(limitCount, limitMinutes, now);
    const enabled = limitCount !== undefined && limitMinutes !== undefined;
    const remainingMs = enabled && this.data.windowStartedAt !== undefined
      ? Math.max(0, this.data.windowStartedAt + limitMinutes * 60_000 - now)
      : undefined;
    return {
      state: this.data.state,
      ...(this.data.reason ? { reason: this.data.reason } : {}),
      ...(this.data.windowStartedAt !== undefined ? { windowStartedAt: this.data.windowStartedAt } : {}),
      ...(remainingMs !== undefined ? { remainingMs } : {}),
      ...(limitMinutes !== undefined ? { limitMinutes } : {}),
      usedSessions: this.data.sessionUsages?.length ?? 0,
      ...(limitCount !== undefined ? { sessionLimit: limitCount } : {}),
      capturedTraceIds: [...(this.data.capturedTraceIds ?? [])],
    };
  }

  admit(
    traceId: string,
    sessionId: string,
    limitCount: number | undefined,
    limitMinutes: number | undefined,
    activeTraceIds: readonly string[],
    now = Date.now(),
  ): ChatGptAccountSafetyAdmission {
    this.syncUsageWindow(limitCount, limitMinutes, now);
    this.finishDrainIfIdle(activeTraceIds);
    this.syncUsageWindow(limitCount, limitMinutes, now);
    if (this.data.state === "HARD_STOP") {
      return { allowed: false, status: this.status(limitCount, limitMinutes, activeTraceIds, now), steeringTraceIds: [] };
    }
    if (this.data.state === "DRAINING") {
      return {
        allowed: this.data.capturedTraceIds?.includes(traceId) === true,
        status: this.status(limitCount, limitMinutes, activeTraceIds, now),
        steeringTraceIds: this.pendingSteering(),
      };
    }
    if (this.data.state === "PAUSED" && this.data.reason !== "duration_limit") {
      return { allowed: false, status: this.status(limitCount, limitMinutes, activeTraceIds, now), steeringTraceIds: [] };
    }
    if (limitCount === undefined || limitMinutes === undefined) {
      return { allowed: true, status: this.status(undefined, undefined, activeTraceIds, now), steeringTraceIds: [] };
    }
    const sessions = new Set((this.data.sessionUsages ?? []).map(usage => usage.id));
    if (sessions.has(sessionId)) {
      return { allowed: true, status: this.status(limitCount, limitMinutes, activeTraceIds, now), steeringTraceIds: [] };
    }
    if (this.data.state === "PAUSED") {
      return { allowed: false, status: this.status(limitCount, limitMinutes, activeTraceIds, now), steeringTraceIds: [] };
    }
    if (sessions.size >= limitCount) {
      this.pauseForSessionLimit();
      return {
        allowed: false,
        status: this.status(limitCount, limitMinutes, activeTraceIds, now),
        steeringTraceIds: [],
      };
    }
    sessions.add(sessionId);
    this.data.sessionUsages = [...(this.data.sessionUsages ?? []), { id: sessionId, usedAt: now }];
    this.data.windowStartedAt ??= now;
    if (sessions.size >= limitCount) this.pauseForSessionLimit();
    else this.persist();
    return {
      allowed: true,
      status: this.status(limitCount, limitMinutes, activeTraceIds, now),
      steeringTraceIds: [],
    };
  }

  trigger(reason: ChatGptAccountSafetyReason, activeTraceIds: readonly string[]): string[] {
    if (this.data.state === "HARD_STOP") return [];
    if (reason === "account_security") {
      this.beginDrain(reason, activeTraceIds);
      return this.pendingSteering();
    }
    if (this.data.state === "DRAINING") {
      return this.pendingSteering();
    }
    if (this.data.state === "PAUSED") {
      if (reason !== "rate_limit" || this.data.reason !== "duration_limit") return [];
      this.beginDrain(reason, activeTraceIds);
      return this.pendingSteering();
    }
    this.beginDrain(reason, activeTraceIds);
    return this.pendingSteering();
  }

  tick(
    limitCount: number | undefined,
    limitMinutes: number | undefined,
    activeTraceIds: readonly string[],
    now = Date.now(),
  ): string[] {
    this.syncUsageWindow(limitCount, limitMinutes, now);
    this.finishDrainIfIdle(activeTraceIds);
    this.syncUsageWindow(limitCount, limitMinutes, now);
    if (this.data.state === "DRAINING") return this.pendingSteering();
    return [];
  }

  markSteeringQueued(traceId: string): void {
    if (this.data.state !== "DRAINING" || !this.data.capturedTraceIds?.includes(traceId)) return;
    const steered = new Set(this.data.steeredTraceIds ?? []);
    if (steered.has(traceId)) return;
    steered.add(traceId);
    this.data.steeredTraceIds = [...steered];
    this.persist();
  }

  resume(): void {
    if (this.data.state === "HARD_STOP") throw new Error("Account safety hard stop requires acknowledgement");
    if (this.data.state === "DRAINING") throw new Error("Account safety is still draining active work");
    if (this.data.state !== "PAUSED") throw new Error("Account safety pause is not active");
    if (this.data.reason === "duration_limit") throw new Error("Automatic Web rolling session limit is still active");
    this.data = { version: 1, state: "NORMAL" };
    this.persist();
  }

  acknowledgeHardStop(): void {
    if (this.data.state !== "HARD_STOP") throw new Error("Account safety hard stop is not active");
    this.data = { version: 1, state: "NORMAL" };
    this.persist();
  }

  resetUsage(): void {
    if (this.data.state === "DRAINING") throw new Error("Account safety is still draining active work");
    if (this.data.state === "HARD_STOP") throw new Error("Account safety hard stop requires acknowledgement");
    delete this.data.windowStartedAt;
    delete this.data.sessionUsages;
    if (this.data.state === "PAUSED" && this.data.reason === "duration_limit") {
      this.data = { version: 1, state: "NORMAL" };
    }
    this.persist();
  }

  retainTrace(traceId: string): void {
    this.traceRefs.set(traceId, (this.traceRefs.get(traceId) ?? 0) + 1);
  }

  releaseTrace(traceId: string): void {
    const refs = this.traceRefs.get(traceId) ?? 0;
    if (refs <= 1) this.traceRefs.delete(traceId);
    else this.traceRefs.set(traceId, refs - 1);
  }

  activeTraceIds(traceIds: readonly string[]): string[] {
    return [...new Set([...traceIds, ...this.traceRefs.keys()])];
  }

  private syncUsageWindow(limitCount: number | undefined, limitMinutes: number | undefined, now: number): void {
    const enabled = limitCount !== undefined && limitMinutes !== undefined;
    if (!enabled) {
      if (this.data.state === "PAUSED" && this.data.reason === "duration_limit") {
        this.data = { version: 1, state: "NORMAL" };
        this.persist();
        return;
      }
      if (this.data.windowStartedAt === undefined && this.data.sessionUsages === undefined) return;
      delete this.data.windowStartedAt;
      delete this.data.sessionUsages;
      this.persist();
      return;
    }
    if (this.data.state === "DRAINING" && this.data.reason === "duration_limit") return;
    const usages = this.data.sessionUsages ?? [];
    const cutoff = now - limitMinutes * 60_000;
    const activeUsages = usages.filter(usage => usage.usedAt > cutoff);
    const windowStartedAt = activeUsages[0]?.usedAt;
    let changed = activeUsages.length !== usages.length || this.data.windowStartedAt !== windowStartedAt;
    if (this.data.state === "PAUSED" && this.data.reason === "duration_limit" && activeUsages.length < limitCount) {
      this.data = { version: 1, state: "NORMAL" };
      changed = true;
    }
    this.data.sessionUsages = activeUsages;
    if (windowStartedAt === undefined) delete this.data.windowStartedAt;
    else this.data.windowStartedAt = windowStartedAt;
    if (changed) this.persist();
  }

  private beginDrain(reason: ChatGptAccountSafetyReason, activeTraceIds: readonly string[]): void {
    const capturedTraceIds = [...new Set(activeTraceIds)];
    const alreadySteered = this.data.state === "DRAINING"
      ? new Set(this.data.steeredTraceIds ?? [])
      : undefined;
    const windowStartedAt = this.data.windowStartedAt;
    const sessionUsages = this.data.sessionUsages;
    this.data = capturedTraceIds.length === 0
      ? {
          version: 1,
          state: targetState(reason),
          reason,
          ...(windowStartedAt !== undefined ? { windowStartedAt } : {}),
          ...(sessionUsages !== undefined ? { sessionUsages } : {}),
        }
      : {
          version: 1,
          state: "DRAINING",
          reason,
          ...(windowStartedAt !== undefined ? { windowStartedAt } : {}),
          ...(sessionUsages !== undefined ? { sessionUsages } : {}),
          capturedTraceIds,
          steeredTraceIds: alreadySteered
            ? capturedTraceIds.filter(traceId => alreadySteered.has(traceId))
            : [],
        };
    this.persist();
  }

  private pauseForSessionLimit(): void {
    this.data = {
      version: 1,
      state: "PAUSED",
      reason: "duration_limit",
      ...(this.data.windowStartedAt !== undefined ? { windowStartedAt: this.data.windowStartedAt } : {}),
      ...(this.data.sessionUsages !== undefined ? { sessionUsages: this.data.sessionUsages } : {}),
    };
    this.persist();
  }

  private finishDrainIfIdle(activeTraceIds: readonly string[]): void {
    if (this.data.state !== "DRAINING") return;
    const active = new Set(activeTraceIds);
    if ((this.data.capturedTraceIds ?? []).some(traceId => active.has(traceId))) return;
    this.data = {
      version: 1,
      state: targetState(this.data.reason ?? "duration_limit"),
      reason: this.data.reason ?? "duration_limit",
      ...(this.data.windowStartedAt !== undefined ? { windowStartedAt: this.data.windowStartedAt } : {}),
      ...(this.data.sessionUsages !== undefined ? { sessionUsages: this.data.sessionUsages } : {}),
    };
    this.persist();
  }

  private pendingSteering(): string[] {
    if (this.data.state !== "DRAINING") return [];
    const steered = new Set(this.data.steeredTraceIds ?? []);
    return (this.data.capturedTraceIds ?? []).filter(traceId => !steered.has(traceId));
  }

  private load(): PersistedSafetyState {
    if (!existsSync(this.path)) return { version: 1, state: "NORMAL" };
    try {
      const parsed = validPersistedSafetyState(JSON.parse(readFileSync(this.path, "utf8")));
      if (!parsed) throw new Error("invalid account-safety state");
      if (!parsed.sessionIds) return parsed;
      const { sessionIds, ...state } = parsed;
      return {
        ...state,
        sessionUsages: sessionIds.map(id => ({ id, usedAt: parsed.windowStartedAt! })),
      };
    } catch (error) {
      console.warn(`[chatgpt-web] invalid account-safety state; Automatic Web is blocked until acknowledgement: ${error instanceof Error ? error.message : String(error)}`);
      return { version: 1, state: "HARD_STOP" };
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(temp, `${JSON.stringify(this.data, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temp, this.path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}

const managers = new Map<string, ChatGptAccountSafety>();

export function chatGptAccountSafety(path = defaultChatGptAccountSafetyStatePath()): ChatGptAccountSafety {
  let manager = managers.get(path);
  if (!manager) {
    manager = new ChatGptAccountSafety(path);
    managers.set(path, manager);
  }
  return manager;
}
