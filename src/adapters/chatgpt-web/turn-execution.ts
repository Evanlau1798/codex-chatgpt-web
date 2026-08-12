import { createHash } from "node:crypto";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import type { BrokerToolRequest } from "./turn-broker";
import { ChatGptSteeringFeed, steeringFingerprint, type ClaudeSteeringDelivery } from "./steering-feed";
import {
  extractChatGptCompactionSourceRevision,
  extractChatGptTurnIdentity,
  extractChatGptTurnUserRevision,
} from "./environment";
export { ChatGptSteeringFeed } from "./steering-feed";

export type ChatGptBrowserOutcome =
  | { type: "final"; answer: string }
  | { type: "error"; error: Error };
export interface ChatGptTraceEvent {
  kind: "reasoning" | "commentary";
  text: string;
  continuation?: boolean;
}

interface FeedWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class ChatGptTraceFeed {
  private readonly queued: ChatGptTraceEvent[] = [];
  private readonly waiters = new Set<FeedWaiter>();
  private progressPending = false;

  push(event: ChatGptTraceEvent): void {
    const normalized = event.continuation ? event.text : event.text.trim();
    if (!normalized) return;
    const normalizedEvent = { ...event, text: normalized };
    this.queued.push(normalizedEvent);
    const waiter = this.waiters.values().next().value as FeedWaiter | undefined;
    if (!waiter) return;
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
  }

  drain(): ChatGptTraceEvent[] {
    this.progressPending = false;
    return this.queued.splice(0);
  }

  signalProgress(): void {
    this.progressPending = true;
    const waiter = this.waiters.values().next().value as FeedWaiter | undefined;
    if (!waiter) return;
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.queued.length > 0 || this.progressPending) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new DOMException("trace wait aborted", "AbortError"));
    return new Promise<void>((resolveWait, rejectWait) => {
      const waiter: FeedWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          rejectWait(new DOMException("trace wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }
}
/** Append-only browser Markdown feed. Waiters are notifications; `drain` owns consumption. */
export class ChatGptTextFeed {
  private readonly queued: string[] = [];
  private readonly waiters = new Set<FeedWaiter>();
  private text = "";

  push(delta: string): void {
    if (!delta) return;
    this.text += delta;
    this.queued.push(delta);
    const waiter = this.waiters.values().next().value as FeedWaiter | undefined;
    if (!waiter) return;
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
  }

  drain(): string[] {
    return this.queued.splice(0);
  }

  value(): string {
    return this.text;
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.queued.length > 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new DOMException("text wait aborted", "AbortError"));
    return new Promise<void>((resolveWait, rejectWait) => {
      const waiter: FeedWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          rejectWait(new DOMException("text wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }
}
interface ChatGptTurnRuntimeBase {
  browser: Promise<string>;
  trace: ChatGptTraceFeed;
  text: ChatGptTextFeed;
  /** Exact bounded request used to prepare this browser turn and report Codex usage. */
  usageInput?: CodexParsedRequest;
  steering?: ChatGptSteeringFeed;
  requestHandoff?: (instructionDelivered?: boolean) => void;
  onToolResultDelivered?: () => void;
  cancel: () => void;
}

export type ChatGptTurnRuntime =
  | (ChatGptTurnRuntimeBase & { mode: "tools"; token: Promise<string> })
  | (ChatGptTurnRuntimeBase & { mode: "read-only" });

function executionKey(parsed: CodexParsedRequest, payload: unknown): string {
  return createHash("sha256").update(JSON.stringify({
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    payload,
  })).digest("hex");
}

function compactionInputRevision(parsed: CodexParsedRequest): unknown[] {
  const body = parsed._rawBody;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("ChatGPT web compaction requires the complete native Codex request body");
  }
  const input = (body as { input?: unknown }).input;
  if (!Array.isArray(input)) {
    throw new Error("ChatGPT web compaction requires the complete native Codex input history");
  }
  return input;
}

export function chatGptTurnExecutionKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  if (!parsed._compactionRequest) extractChatGptTurnUserRevision(parsed);
  return executionKey(parsed, {
    threadId: identity.threadId,
    turnId: identity.turnId,
    purpose: parsed._compactionRequest ? "compaction" : "response",
    ...(parsed._compactionRequest ? { revision: compactionInputRevision(parsed) } : {}),
  });
}

export function chatGptConversationKey(parsed: CodexParsedRequest, namespace: string): string | undefined {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId) return undefined;
  const raw = parsed._rawBody as { input?: unknown[] } | undefined;
  const compaction = raw?.input?.findLast(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const type = (item as { type?: unknown }).type;
    return type === "compaction" || type === "compaction_summary" || type === "context_compaction";
  });
  return createHash("sha256").update(JSON.stringify({
    namespace,
    threadId: identity.threadId,
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    compaction: compaction ?? null,
  })).digest("hex");
}

export function chatGptTurnSteeringId(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

/** Locate the browser response that a native mid-turn compaction replaces. */
export function chatGptCompactionSourceExecutionKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  const source = extractChatGptCompactionSourceRevision(parsed);
  return executionKey(parsed, {
    threadId: identity.threadId,
    turnId: source.turnId ?? identity.turnId,
    purpose: "response",
  });
}

export class ChatGptTurnSession {
  readonly createdAt = Date.now();
  private lastTouchedAt = this.createdAt;
  readonly browserOutcome: Promise<ChatGptBrowserOutcome>;
  private readonly outstandingById = new Map<string, BrokerToolRequest>();
  private readonly deliveredResultIds = new Set<string>();
  private outstandingReasoning: string[] = [];
  private finalReasoning: string[] = [];
  private outstandingPrelude: AdapterEvent[] = [];
  private finalPrelude: AdapterEvent[] = [];
  private handoff?: string;
  private userRevision?: string; private readonly seenUserRevisions: string[] = [];
  private readonly hookedSteeringReplays: string[] = [];
  private readonly steering: ChatGptSteeringFeed;
  private settledBrowserOutcome?: ChatGptBrowserOutcome;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    readonly runtime: ChatGptTurnRuntime,
    readonly group?: string,
    readonly steeringId?: string,
    readonly claudeRootThreadId?: string,
  ) {
    this.steering = runtime.steering ?? new ChatGptSteeringFeed();
    this.browserOutcome = runtime.browser
      .then(answer => ({ type: "final", answer }) as ChatGptBrowserOutcome)
      .catch(error => ({ type: "error", error: error instanceof Error ? error : new Error(String(error)) }) as ChatGptBrowserOutcome)
      .then(outcome => {
      if (this.claudeRootThreadId) this.steering.settleClaude(outcome.type === "final");
      this.settledBrowserOutcome = outcome;
      return outcome;
    });
  }

  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    this.touch();
    const run = this.tail.then(task);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  touch(): void {
    this.lastTouchedAt = Date.now();
  }

  lastUsedAt(): number {
    return this.lastTouchedAt;
  }

  outstanding(): BrokerToolRequest[] {
    return [...this.outstandingById.values()];
  }

  settledOutcome(): ChatGptBrowserOutcome | undefined {
    return this.settledBrowserOutcome;
  }

  isActive(): boolean {
    return this.settledBrowserOutcome === undefined;
  }

  setOutstanding(requests: BrokerToolRequest[], reasoning: string[] = [], prelude: AdapterEvent[] = []): void {
    if (this.outstandingById.size > 0) throw new Error("cannot emit a new ChatGPT tool batch while the previous batch is unresolved");
    for (const request of requests) {
      if (this.deliveredResultIds.has(request.callId) || this.outstandingById.has(request.callId)) {
        throw new Error(`duplicate ChatGPT bridge tool call id: ${request.callId}`);
      }
      this.outstandingById.set(request.callId, request);
    }
    this.outstandingReasoning = [...reasoning];
    this.outstandingPrelude = [...prelude];
  }

  hasOutstanding(callId: string): boolean {
    return this.outstandingById.has(callId);
  }

  markResultDelivered(callId: string): void {
    if (!this.outstandingById.delete(callId)) throw new Error(`ChatGPT bridge tool result does not match an outstanding call: ${callId}`);
    this.deliveredResultIds.add(callId);
    this.runtime.onToolResultDelivered?.();
    if (this.outstandingById.size === 0) {
      this.outstandingReasoning = [];
      this.outstandingPrelude = [];
    }
  }

  reasoningForOutstandingReplay(): string[] {
    return [...this.outstandingReasoning];
  }

  eventsForOutstandingReplay(): AdapterEvent[] {
    return [...this.outstandingPrelude];
  }

  setFinalReasoning(reasoning: string[]): void {
    this.finalReasoning = [...reasoning];
  }

  reasoningForFinalReplay(): string[] {
    return [...this.finalReasoning];
  }

  setFinalEvents(events: AdapterEvent[]): void {
    this.finalPrelude = [...events];
  }

  eventsForFinalReplay(): AdapterEvent[] {
    return [...this.finalPrelude];
  }

  setCompactionHandoff(text: string): void { this.handoff = text; }

  compactionHandoff(): string | undefined { return this.handoff; }

  updateUserRevision(revision: string, steering: string, queue = true): string | undefined {
    if (this.userRevision === undefined) {
      this.seenUserRevisions.push(this.userRevision = revision);
      return undefined;
    }
    if (this.userRevision === revision) return undefined;
    this.userRevision = revision;
    if (this.seenUserRevisions.includes(revision)) return undefined;
    if (this.seenUserRevisions.push(revision) > 32) this.seenUserRevisions.shift();
    const hooked = this.hookedSteeringReplays.indexOf(steeringFingerprint(steering));
    if (hooked >= 0) {
      this.hookedSteeringReplays.splice(hooked, 1);
      return undefined;
    }
    if (queue) this.steering.push(steering);
    return steering;
  }

  peekPendingSteering() { return this.steering.peek(); }
  takePendingSteering(count?: number): string | undefined { return this.steering.take(count); }
  queueSteering(steering: string, hooked = false, deliveryId?: string): boolean {
    if (hooked && !this.steering.pushClaude(steering, deliveryId)) return false;
    if (hooked) {
      this.hookedSteeringReplays.push(steeringFingerprint(steering));
      if (this.hookedSteeringReplays.length > 32) this.hookedSteeringReplays.shift();
    }
    if (!hooked) this.steering.push(steering);
    return true;
  }

  syncClaudeSteering(active: ClaudeSteeringDelivery[]): number {
    const accepted = this.steering.syncClaude(active);
    this.hookedSteeringReplays.push(...accepted.map(steeringFingerprint));
    if (this.hookedSteeringReplays.length > 32) this.hookedSteeringReplays.splice(0, this.hookedSteeringReplays.length - 32);
    return accepted.length;
  }

  acknowledgePendingClaudeSteering(count: number): string | undefined { return this.steering.acknowledgeClaude(count); }
  claudeSteeringSuppressionCount(instruction: string): number { return this.steering.claudeSuppressionCount(instruction); }
  completedClaudeSteeringFingerprints(): string[] { return this.steering.completedClaudeFingerprints(); }
  inheritCompletedClaudeSteering(fingerprints: string[]): void { this.steering.inheritCompletedClaude(fingerprints); }

  clearOutstanding(): void {
    this.outstandingById.clear();
    this.outstandingReasoning = [];
    this.outstandingPrelude = [];
  }

  cancel(): void { this.runtime.cancel(); }
}

export class ChatGptTurnSessions {
  private readonly entries = new Map<string, ChatGptTurnSession>();
  private readonly retirements = new Map<string, Promise<void>>();

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly maxEntries = 256,
  ) {}

  getOrCreate(
    key: string,
    start: () => ChatGptTurnRuntime,
    group?: string,
    steeringId?: string,
    claudeRootThreadId?: string,
  ): ChatGptTurnSession {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      existing.touch();
      return existing;
    }
    if (this.entries.size >= this.maxEntries) throw new Error(`ChatGPT web session registry is full (${this.maxEntries} entries)`);
    const session = new ChatGptTurnSession(start(), group, steeringId, claudeRootThreadId);
    this.entries.set(key, session);
    return session;
  }

  find(key: string): ChatGptTurnSession | undefined {
    this.prune();
    return this.entries.get(key);
  }

  async waitForRetirement(key: string): Promise<void> {
    await this.retirements.get(key);
  }

  async retireAndWait(key: string): Promise<boolean> {
    const pending = this.retirements.get(key);
    if (pending) {
      await pending;
      return true;
    }
    const session = this.entries.get(key);
    if (!session) return false;

    this.entries.delete(key);
    session.cancel();
    const retirement = session.browserOutcome.then(() => undefined);
    this.retirements.set(key, retirement);
    try {
      await retirement;
    } finally {
      if (this.retirements.get(key) === retirement) this.retirements.delete(key);
    }
    return true;
  }

  retire(key: string, session: ChatGptTurnSession): boolean {
    if (this.entries.get(key) !== session) return false;
    session.cancel();
    this.entries.delete(key);
    return true;
  }

  steer(steeringId: string, instruction: string): boolean {
    this.prune();
    let target: ChatGptTurnSession | undefined;
    for (const session of this.entries.values()) {
      if (session.isActive() && session.steeringId === steeringId) target = session;
    }
    target?.queueSteering(instruction);
    return Boolean(target);
  }

  steerClaudeRoot(
    threadId: string,
    instruction: string,
    source?: { deliveryId: string; occurredAt: number },
  ): "accepted" | "inactive" | "ambiguous" | "duplicate" | "stale" {
    this.prune();
    const targets = [...this.entries.values()].filter(session => (
      session.isActive() && session.claudeRootThreadId === threadId
    ));
    if (targets.length === 0) return "inactive";
    if (targets.length > 1) return "ambiguous";
    const target = targets[0]!;
    if (source && source.occurredAt < target.createdAt) return "stale";
    return target.queueSteering(instruction, true, source?.deliveryId) ? "accepted" : "duplicate";
  }

  syncClaudeRoot(threadId: string, active: Array<ClaudeSteeringDelivery & { occurredAt: number }>): number | "inactive" | "ambiguous" {
    this.prune();
    const targets = [...this.entries.values()].filter(session => session.isActive() && session.claudeRootThreadId === threadId);
    if (targets.length === 0) return "inactive";
    if (targets.length > 1) return "ambiguous";
    const target = targets[0]!;
    return target.syncClaudeSteering(active.filter(item => item.occurredAt >= target.createdAt));
  }

  claudeSteeringSuppressionCount(threadId: string, instruction: string): number {
    this.prune();
    const targets = [...this.entries.values()].filter(session => session.claudeRootThreadId === threadId);
    return targets.length === 1 ? targets[0]!.claudeSteeringSuppressionCount(instruction) : 0;
  }

  retireGroup(group: string): number {
    let retired = 0;
    for (const [key, session] of this.entries) {
      if (session.group === group && this.retire(key, session)) retired += 1;
    }
    return retired;
  }

  clear(): number {
    const cancelled = this.entries.size;
    for (const session of this.entries.values()) session.cancel();
    this.entries.clear();
    return cancelled;
  }
  activeCount(): number {
    this.prune();
    let active = 0;
    for (const session of this.entries.values()) if (session.isActive()) active += 1;
    return active;
  }
  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, session] of this.entries) {
      if (session.isActive() || session.lastUsedAt() >= cutoff) continue;
      session.cancel();
      this.entries.delete(key);
    }
  }
}

export const chatGptTurnSessions = new ChatGptTurnSessions();
