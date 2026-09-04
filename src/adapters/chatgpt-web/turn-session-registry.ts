import { chatGptBrowserTabClosedError } from "./adapter-error";
import { ChatGptAgentSessionGraph } from "./agent-session-graph";
import { withAbort } from "./runtime-lifecycle";
import type { ClaudeSteeringDelivery } from "./steering-feed";
import { ChatGptTurnSession, type ChatGptTurnRuntime } from "./turn-execution";
import { trackConversationRetirement } from "./turn-retirement-state";

export class ChatGptTurnSessions {
  private readonly entries = new Map<string, ChatGptTurnSession>();
  private readonly retirements = new Map<string, Promise<void>>();
  private readonly conversationRetirements = new Map<string, Promise<void>>();
  private readonly manualOwnerRetirements = new Map<string, Promise<void>>();
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
    traceId?: string,
  ): ChatGptTurnSession {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      existing.touch();
      return existing;
    }
    if (this.entries.size >= this.maxEntries) throw new Error(`ChatGPT web session registry is full (${this.maxEntries} entries)`);
    const session = new ChatGptTurnSession(start(), group, steeringId, claudeRootThreadId, traceId);
    this.entries.set(key, session);
    return session;
  }

  async getOrCreateAfterConversationRetirement(
    key: string,
    conversationKey: string | undefined,
    start: () => ChatGptTurnRuntime,
    group?: string,
    steeringId?: string,
    claudeRootThreadId?: string,
    traceId?: string,
    signal?: AbortSignal,
    manualOwner?: { key: string; abortedSteeringIds: ReadonlySet<string> },
  ): Promise<ChatGptTurnSession> {
    if (manualOwner) {
      for (const [ownedKey, session] of this.entries) {
        if (ownedKey !== key && session.runtime.manualControl?.ownerKey === manualOwner.key
          && session.steeringId && manualOwner.abortedSteeringIds.has(session.steeringId) && session.isActive()) {
          this.retire(ownedKey, session);
        }
      }
    }
    for (;;) {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const existing = manualOwner ? this.entries.get(key) : undefined;
      if (existing) { existing.touch(); return existing; }
      const pending = this.retirements.get(key)
        ?? (manualOwner ? this.manualOwnerRetirements.get(manualOwner.key) : undefined)
        ?? (conversationKey ? this.conversationRetirements.get(conversationKey) : undefined);
      if (pending) {
        await withAbort(pending, signal);
        continue;
      }
      const activeOwner = (manualOwner || conversationKey)
        ? [...this.entries].find(([ownedKey, session]) => (
            ownedKey !== key
            && (manualOwner ? session.runtime.manualControl?.ownerKey === manualOwner.key
              : session.conversationKey() === conversationKey)
            && session.browserTurnPending()
          ))
        : undefined;
      if (activeOwner) {
        const [ownedKey, ownedSession] = activeOwner;
        if (this.entries.get(ownedKey) !== ownedSession) continue;
        if (manualOwner) {
          await withAbort(ownedSession.physicalSettlement, signal);
          continue;
        }
        this.entries.delete(ownedKey);
        await withAbort(this.beginRetirement(ownedKey, ownedSession), signal);
        continue;
      }
      return this.getOrCreate(key, () => {
        const runtime = start();
        if (manualOwner && runtime.manualControl) runtime.manualControl.ownerKey = manualOwner.key;
        return runtime;
      }, group, steeringId, claudeRootThreadId, traceId);
    }
  }

  find(key: string): ChatGptTurnSession | undefined {
    this.prune();
    return this.entries.get(key);
  }

  async waitForRetirement(key: string, signal?: AbortSignal): Promise<void> {
    const pending = this.retirements.get(key);
    if (pending) await withAbort(pending, signal);
  }

  async waitForConversationRetirement(key: string, signal?: AbortSignal): Promise<void> {
    const pending = this.conversationRetirements.get(key);
    if (pending) await withAbort(pending, signal);
  }

  async retireAndWait(
    key: string,
    preserveConversationKeyOrSignal?: string | AbortSignal,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const preserveConversationKey = typeof preserveConversationKeyOrSignal === "string"
      ? preserveConversationKeyOrSignal
      : undefined;
    const waitSignal = typeof preserveConversationKeyOrSignal === "string"
      ? signal
      : preserveConversationKeyOrSignal;
    const session = this.entries.get(key);
    if (session) {
      this.entries.delete(key);
      await withAbort(this.beginRetirement(key, session, preserveConversationKey), waitSignal);
      return true;
    }
    const pending = this.retirements.get(key);
    if (!pending) return false;
    await withAbort(pending, waitSignal);
    return true;
  }

  async retireConversationAndWait(conversationKey: string): Promise<number> {
    return this.closeConversationAndWait(conversationKey);
  }

  async retireConversationPreservingFinalResponse(
    conversationKey: string,
    preserved: ChatGptTurnSession,
    preservedExecutionKey: string,
  ): Promise<number> {
    if (!preservedExecutionKey) throw new Error("Preserved ChatGPT response execution key is required");
    if (preserved.settledOutcome()?.type !== "final") {
      throw new Error("Only a settled final ChatGPT response can survive retained-conversation retirement");
    }
    return this.closeConversationAndWait(conversationKey, {
      session: preserved,
      executionKey: preservedExecutionKey,
    });
  }

  private async closeConversationAndWait(
    conversationKey: string,
    preserved?: { session: ChatGptTurnSession; executionKey: string },
  ): Promise<number> {
    const pending = this.conversationRetirements.get(conversationKey);
    if (pending) {
      await pending;
      return 0;
    }
    const owned = [...this.entries].filter(([, session]) => (
      session.conversationKey() === conversationKey
    ));
    if (owned.length === 0) return 0;
    if (preserved && !owned.some(([, session]) => session === preserved.session)) {
      throw new Error("The final ChatGPT response does not own the retained conversation being retired");
    }
    const target = preserved ? this.entries.get(preserved.executionKey) : undefined;
    if (target && target !== preserved?.session) {
      throw new Error("The compacted ChatGPT response execution key is already owned by another session");
    }
    for (const [key, session] of owned) {
      if (this.entries.get(key) === session
        && (session !== preserved?.session || key !== preserved.executionKey)) {
        this.entries.delete(key);
      }
      if (session.isActive()) session.cancel();
      if (!session.detachConversation(conversationKey)) {
        throw new Error("ChatGPT retained-conversation ownership changed during retirement");
      }
    }
    if (preserved) this.entries.set(preserved.executionKey, preserved.session);
    const release = owned.find(([, session]) => session.runtime.release)?.[1].runtime.release;
    const retirement = trackConversationRetirement(
      this.conversationRetirements,
      conversationKey,
      Promise.all(owned.map(([, session]) => session.physicalSettlement)).then(async () => { await release?.(); }),
    );
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
    session.cancel();
    const preserveSurface = preserveConversationKey !== undefined
      && session.conversationKey() === preserveConversationKey;
    const release = preserveSurface ? undefined : session.runtime.release;
    const retirement = trackConversationRetirement(
      this.retirements, key, session.physicalSettlement.then(async () => { await release?.(); }),
    );
    const conversationKey = session.conversationKey();
    if (conversationKey) {
      trackConversationRetirement(this.conversationRetirements, conversationKey, retirement);
    }
    const manualOwnerKey = session.runtime.manualControl?.ownerKey;
    if (manualOwnerKey) trackConversationRetirement(this.manualOwnerRetirements, manualOwnerKey, retirement);
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

  syncClaudeRoot(
    threadId: string,
    active: Array<ClaudeSteeringDelivery & { occurredAt: number }>,
    observedThrough?: number,
  ): number | "inactive" | "ambiguous" {
    this.prune();
    const targets = [...this.entries.values()].filter(session => session.isActive() && session.claudeRootThreadId === threadId);
    if (targets.length === 0) return "inactive";
    if (targets.length > 1) return "ambiguous";
    const target = targets[0]!;
    return target.syncClaudeSteering(active.filter(item => item.occurredAt >= target.createdAt), observedThrough);
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
    for (const [key, session] of [...this.entries]) this.retire(key, session);
    this.agentGraph.clear();
    return cancelled;
  }

  async cancelTrace(traceId: string, reason = chatGptBrowserTabClosedError()): Promise<number> {
    const sessions = [...this.entries.values()]
      .filter(session => session.traceId === traceId && session.isActive());
    for (const session of sessions) session.cancel(reason);
    await Promise.all(sessions.map(session => session.browserOutcome.then(() => undefined)));
    return sessions.length;
  }

  cancelledError(traceId: string): Error | undefined {
    for (const session of this.entries.values()) {
      if (session.traceId !== traceId) continue;
      const outcome = session.settledOutcome();
      if (outcome?.type !== "error") continue;
      if ("code" in outcome.error && outcome.error.code === "client_cancelled") return outcome.error;
    }
    return undefined;
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
      this.retire(key, session);
    }
  }
}

export const chatGptTurnSessions = new ChatGptTurnSessions();
