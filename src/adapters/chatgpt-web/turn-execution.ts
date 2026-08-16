import { createHash } from "node:crypto";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import type { BrokerToolRequest } from "./turn-broker";
import { ChatGptSteeringFeed, steeringFingerprint, type ClaudeSteeringDelivery } from "./steering-feed";
import { ChatGptTextFeed, ChatGptTraceFeed } from "./turn-feeds";
import { ChatGptAgentSessionGraph } from "./agent-session-graph";
import {
  extractChatGptCompactionSourceRevision,
  extractChatGptTurnIdentity,
  extractChatGptTurnUserRevision,
} from "./environment";
export { chatGptConversationKey, chatGptTurnTraceId } from "./conversation-key";
export { ChatGptSteeringFeed } from "./steering-feed";
export { ChatGptTextFeed, ChatGptTraceFeed, type ChatGptTraceEvent } from "./turn-feeds";

export type ChatGptBrowserOutcome =
  | { type: "final"; answer: string }
  | { type: "error"; error: Error };
interface ChatGptTurnRuntimeBase {
  browser: Promise<string>;
  trace: ChatGptTraceFeed;
  text: ChatGptTextFeed;
  conversationKey?: string;
  /** Exact bounded request used to prepare this browser turn and report Codex usage. */
  usageInput?: CodexParsedRequest;
  steering?: ChatGptSteeringFeed;
  requestHandoff?: (instructionDelivered?: boolean) => void;
  onToolResultDelivered?: () => void;
  submission?: { accepted: boolean };
  cancel: () => void;
  /** Release a completed retained browser surface when this canonical session is superseded. */
  release?: () => Promise<void>;
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

export function chatGptTurnSteeringId(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

/** Stable identity for limiting automatic retries of one native Codex turn. */
export function chatGptTurnRetryKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-turn retry budgeting");
  return createHash("sha256").update(JSON.stringify({
    threadId: identity.threadId,
    turnId: identity.turnId,
    purpose: parsed._compactionRequest ? "compaction" : "response",
  })).digest("hex");
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
  private readonly outstandingGenerationById = new Map<string, number>();
  private readonly supersededResultIds = new Map<string, number>();
  private canonicalGeneration = 0;
  private canonicalComplete = false;
  private canonicalCallIds = new Set<string>();
  private canonicalResultIds = new Set<string>();
  private cancelledBeforeCanonical = 0;
  private resolvedSuperseded = 0;
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
      this.steering.settleClaude(outcome.type === "final");
      this.settledBrowserOutcome ??= outcome;
      return this.settledBrowserOutcome;
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
  setTerminalError(error: Error): void { this.settledBrowserOutcome = { type: "error", error }; }
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
      this.outstandingGenerationById.set(request.callId, this.canonicalGeneration);
    }
    this.outstandingReasoning = [...reasoning];
    this.outstandingPrelude = [...prelude];
  }

  hasOutstanding(callId: string): boolean {
    return this.outstandingById.has(callId);
  }

  markResultDelivered(callId: string): void {
    if (!this.outstandingById.delete(callId)) throw new Error(`ChatGPT bridge tool result does not match an outstanding call: ${callId}`);
    this.outstandingGenerationById.delete(callId);
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
  peekPendingClaudeSteering() { return this.steering.peekClaude(); }
  takePendingSteering(count?: number): string | undefined { return this.steering.take(count); }
  queueSteering(steering: string, hooked = false, deliveryId?: string, source: "user" | "coordinator" = "user"): boolean {
    if (hooked && !this.steering.pushClaude(steering, deliveryId, source)) return false;
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
  completedClaudeSteering() { return this.steering.completedClaudeSteering(); }
  inheritCompletedClaudeSteering(deliveries: ReturnType<ChatGptSteeringFeed["completedClaudeSteering"]>): void {
    this.steering.inheritCompletedClaude(deliveries);
  }

  supersedeOutstanding(): string[] {
    const superseded = [...this.outstandingById.keys()];
    for (const callId of superseded) {
      this.supersededResultIds.set(callId, this.outstandingGenerationById.get(callId) ?? this.canonicalGeneration);
    }
    this.outstandingById.clear();
    this.outstandingGenerationById.clear();
    this.outstandingReasoning = [];
    this.outstandingPrelude = [];
    this.reconcileSupersededCalls();
    return superseded;
  }

  observeCanonicalRequest(parsed: CodexParsedRequest): void {
    this.canonicalGeneration += 1;
    this.canonicalComplete = parsed._canonicalContextComplete === true;
    this.canonicalCallIds = new Set(parsed.context.messages.flatMap(message => (
      message.role === "assistant" ? message.content.flatMap(part => part.type === "toolCall" ? [part.id] : []) : []
    )));
    this.canonicalResultIds = new Set(parsed.context.messages.flatMap(message => (
      message.role === "toolResult" ? [message.toolCallId] : []
    )));
    this.reconcileSupersededCalls();
  }

  unresolvedSupersededResultIds(): string[] { return [...this.supersededResultIds.keys()]; }

  canonicalCallDiagnostics() {
    return {
      generation: this.canonicalGeneration,
      complete: this.canonicalComplete,
      calls: this.canonicalCallIds.size,
      results: this.canonicalResultIds.size,
      cancelledBeforeCanonical: this.cancelledBeforeCanonical,
      resolvedSuperseded: this.resolvedSuperseded,
    };
  }

  private reconcileSupersededCalls(): void {
    for (const [callId, createdGeneration] of this.supersededResultIds) {
      if (this.canonicalResultIds.has(callId)) {
        this.supersededResultIds.delete(callId);
        this.resolvedSuperseded += 1;
      } else if (this.canonicalComplete && createdGeneration < this.canonicalGeneration
        && !this.canonicalCallIds.has(callId)) {
        this.supersededResultIds.delete(callId);
        this.cancelledBeforeCanonical += 1;
      }
    }
  }

  cancel(): void { this.runtime.cancel(); }
}

export class ChatGptTurnSessions {
  private readonly entries = new Map<string, ChatGptTurnSession>();
  private readonly retirements = new Map<string, Promise<void>>();
  private readonly agentGraph = new ChatGptAgentSessionGraph();

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

  async retireAndWait(key: string, preserveConversationKey?: string): Promise<boolean> {
    const pending = this.retirements.get(key);
    if (pending) {
      await pending;
      return true;
    }
    const session = this.entries.get(key);
    if (!session) return false;

    this.entries.delete(key);
    await this.beginRetirement(key, session, preserveConversationKey);
    return true;
  }

  async retireConversationAndWait(conversationKey: string): Promise<number> {
    const owned = [...this.entries].filter(([, session]) => (
      session.runtime.conversationKey === conversationKey
    ));
    if (owned.length === 0) return 0;
    for (const [key, session] of owned) {
      if (this.entries.get(key) !== session) continue;
      this.entries.delete(key);
      session.cancel();
    }
    const release = owned.find(([, session]) => session.runtime.release)?.[1].runtime.release;
    const retirement = Promise.all(owned.map(([, session]) => session.browserOutcome))
      .then(async () => { await release?.(); });
    for (const [key] of owned) this.retirements.set(key, retirement);
    try {
      await retirement;
    } finally {
      for (const [key] of owned) {
        if (this.retirements.get(key) === retirement) this.retirements.delete(key);
      }
    }
    return owned.length;
  }

  retire(key: string, session: ChatGptTurnSession): boolean {
    if (this.entries.get(key) !== session) return false;
    this.entries.delete(key);
    void this.beginRetirement(key, session).catch(error => {
      console.warn(`[chatgpt-web] failed to release retired browser session: ${error instanceof Error ? error.message : String(error)}`);
    });
    return true;
  }

  private beginRetirement(key: string, session: ChatGptTurnSession, preserveConversationKey?: string): Promise<void> {
    const existing = this.retirements.get(key);
    if (existing) return existing;
    session.cancel();
    const preserveSurface = preserveConversationKey !== undefined
      && session.runtime.conversationKey === preserveConversationKey;
    const release = preserveSurface ? undefined : session.runtime.release;
    const retirement = session.browserOutcome.then(async () => { await release?.(); });
    this.retirements.set(key, retirement);
    void retirement.then(() => {
      if (this.retirements.get(key) === retirement) this.retirements.delete(key);
    }, () => {
      if (this.retirements.get(key) === retirement) this.retirements.delete(key);
    });
    return retirement;
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

  steerClaudeAgent(
    steeringId: string,
    instruction: string,
    deliveryId: string,
  ): "accepted" | "inactive" | "ambiguous" | "duplicate" {
    this.prune();
    const targets = [...this.entries.values()].filter(session => (
      session.isActive() && session.steeringId === steeringId
    ));
    if (targets.length === 0) return "inactive";
    if (targets.length > 1) return "ambiguous";
    return targets[0]!.queueSteering(instruction, true, deliveryId, "coordinator") ? "accepted" : "duplicate";
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

  claudeSteeringSuppressionCountBySteeringId(steeringId: string, instruction: string): number {
    this.prune();
    const targets = [...this.entries.values()].filter(session => session.steeringId === steeringId);
    return targets.length === 1 ? targets[0]!.claudeSteeringSuppressionCount(instruction) : 0;
  }

  retireGroup(group: string): number {
    let retired = 0;
    for (const [key, session] of this.entries) {
      if (session.group === group && this.retire(key, session)) retired += 1;
    }
    return retired;
  }

  linkGroups(parent: string, child: string): void { this.agentGraph.link(parent, child); }
  linkAgentReference(parent: string, reference: string): void { this.agentGraph.linkReference(parent, reference); }

  retireAgentReference(parent: string, reference: string, descendants: boolean): number {
    const group = this.agentGraph.resolveReference(parent, reference);
    if (!group) return 0;
    return descendants ? this.retireGroupTree(group) : this.retireGroup(group);
  }

  retireGroupTree(group: string): number {
    const groups = this.agentGraph.descendants(group);
    let retired = 0;
    for (const target of groups) retired += this.retireGroup(target);
    this.agentGraph.forget(groups);
    return retired;
  }

  clear(): number {
    const cancelled = this.entries.size;
    for (const session of this.entries.values()) session.cancel();
    this.entries.clear();
    this.agentGraph.clear();
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
