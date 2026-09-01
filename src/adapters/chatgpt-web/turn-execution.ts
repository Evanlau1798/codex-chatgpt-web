import type { AdapterEvent, CodexParsedRequest, CodexToolResultMessage } from "../../types";
import type { BrokerToolRequest } from "./turn-broker";
import { ChatGptSteeringFeed, steeringFingerprint, type ClaudeSteeringDelivery } from "./steering-feed";
import { ChatGptTextFeed, ChatGptTraceFeed } from "./turn-feeds";
import type { ChatGptExternalTurnProgress } from "./turn-progress";
export { chatGptConversationKey, chatGptTurnTraceId } from "./conversation-key";
export {
  chatGptCompactionSourceExecutionKey,
  chatGptTurnExecutionKey,
  chatGptTurnSteeringId,
} from "./turn-execution-key";
export { ChatGptSteeringFeed } from "./steering-feed";
export { ChatGptTextFeed, ChatGptTraceFeed, type ChatGptTraceEvent } from "./turn-feeds";
export { ChatGptTurnSessions, chatGptTurnSessions } from "./turn-session-registry";

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
  /** Stop only the active Web generation and continue on the same retained surface. */
  preemptHandoff?: (instruction: string) => boolean;
  requestHandoff?: (instruction: string, instructionDelivered?: boolean) => void;
  onToolResultDelivered?: (result?: CodexToolResultMessage) => void;
  externalProgress?: ChatGptExternalTurnProgress;
  submission?: { phase: "prepared" | "send_activated" | "accepted" };
  cancel: (reason?: Error) => void;
  /** Release a completed retained browser surface when this canonical session is superseded. */
  release?: () => Promise<void>;
}
export type ChatGptTurnRuntime =
  | (ChatGptTurnRuntimeBase & { mode: "tools"; token: Promise<string> })
  | (ChatGptTurnRuntimeBase & { mode: "read-only" });

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
  private physicalBrowserSettled = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    readonly runtime: ChatGptTurnRuntime,
    readonly group?: string,
    readonly steeringId?: string,
    readonly claudeRootThreadId?: string,
    readonly traceId?: string,
  ) {
    this.steering = runtime.steering ?? new ChatGptSteeringFeed();
    this.browserOutcome = runtime.browser
      .then(answer => ({ type: "final", answer }) as ChatGptBrowserOutcome)
      .catch(error => ({ type: "error", error: error instanceof Error ? error : new Error(String(error)) }) as ChatGptBrowserOutcome)
      .then(outcome => {
      this.steering.settleClaude(outcome.type === "final");
      this.settledBrowserOutcome ??= outcome;
      this.physicalBrowserSettled = true;
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
  browserTurnPending(): boolean { return !this.physicalBrowserSettled; }

  setOutstanding(requests: BrokerToolRequest[], reasoning: string[] = [], prelude: AdapterEvent[] = []): number | undefined {
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
    return this.runtime.externalProgress?.recordToolBatch(requests.length);
  }

  hasOutstanding(callId: string): boolean {
    return this.outstandingById.has(callId);
  }

  markResultDelivered(callId: string, result?: CodexToolResultMessage): void {
    if (!this.outstandingById.delete(callId)) throw new Error(`ChatGPT bridge tool result does not match an outstanding call: ${callId}`);
    this.outstandingGenerationById.delete(callId);
    this.deliveredResultIds.add(callId);
    this.runtime.externalProgress?.recordToolResult();
    this.runtime.onToolResultDelivered?.(result);
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

  syncClaudeSteering(active: ClaudeSteeringDelivery[], observedThrough?: number): number {
    const accepted = this.steering.syncClaude(active, observedThrough);
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
      this.runtime.externalProgress?.recordToolResult();
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

  cancel(reason?: Error): void { this.runtime.cancel(reason); }
}
