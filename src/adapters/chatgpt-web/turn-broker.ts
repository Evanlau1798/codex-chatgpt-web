import { existsSync, lstatSync, unlinkSync } from "node:fs";
import type { Server } from "node:net";
import { isWindowsPipeEndpoint } from "../../config";
import { CompactionTransactionStore, type CompactionTransactionHandle } from "./compaction-transaction";
import type { ChatGptTurnEnvironment } from "./environment";
import { dispatchTurnBrokerRequest } from "./turn-broker-dispatch";
import { startTurnBrokerServer } from "./turn-broker-server";
import type { TurnBrokerOwner } from "./turn-broker-owner";
import {
  environmentIdentity,
  steeringResult,
  type ToolWaiter,
  type TurnChannel,
} from "./turn-broker-state";
import { opaqueId, type BrokerToolRequest, type BrokerToolResult } from "./turn-broker-protocol";
import { TurnContextStore } from "./turn-context-store";
import { beginTurnCompletionFence, commitTurnCompletionFence } from "./turn-broker-completion";
import { rejectTurnChannel, takeQueuedTools } from "./turn-broker-queue";
import {
  assertSafeHarnessRunning,
  waitForSafeState,
  resolveSafeWaiters,
  confirmSafeTurnSent as confirmSafeSent,
  completeSafeTurn as completeSafe,
  createSafeTurn,
  revokeSafeTurn,
  startSafeTurn as startSafe,
  waitForSafeCompletion as waitSafeCompletion,
  waitForSafeStart as waitSafeStart,
} from "./turn-broker-safe";

export { callTurnBroker, TurnBrokerTimeoutError } from "./turn-broker-client";
export { RemoteTurnBroker } from "./turn-broker-owner";
export type { TurnBrokerOwner } from "./turn-broker-owner";
export type { BrokerToolRequest, BrokerToolResult } from "./turn-broker-protocol";

const brokers = new Map<string, TurnBroker>();
const MAX_RETIRED_TURN_HANDLES = 64;

export async function closeTurnBrokers(): Promise<void> {
  const active = [...brokers.values()];
  const results = await Promise.allSettled(active.map(broker => broker.close()));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map(result => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} ChatGPT turn broker(s) failed to close`);
  }
}
export class TurnBroker implements TurnBrokerOwner {
  static forSocket(path: string): TurnBroker {
    let broker = brokers.get(path);
    if (!broker) {
      broker = new TurnBroker(path);
      brokers.set(path, broker);
    }
    return broker;
  }

  private readonly channels = new Map<string, TurnChannel>();
  private readonly pending = new Map<string, TurnChannel>();
  private readonly compactionTransactions = new CompactionTransactionStore();
  private readonly contexts = new TurnContextStore();
  private readonly bindings = new Map<string, { token: string; channel: TurnChannel }>();
  // The Codex context replayed into ChatGPT still carries the handles of finished turns, so a model
  // can present one. Remembering which turn retired a handle is what separates "you are holding a
  // previous turn's handle" from "this handle never existed".
  private readonly retiredBindings = new Map<string, string>();
  private readonly retiredTokens = new Map<string, string>();
  private acceptingExternalOwners = true;
  private server?: Server;
  private startPromise?: Promise<void>;

  private constructor(readonly socketPath: string) {}

  /**
   * A ChatGPT turn outlives the request that started it, and its Codex Native calls arrive from a
   * separate MCP process. Creating the socket only once a turn registers leaves that process
   * connecting to a path that does not exist yet, so an in-flight turn reports a filesystem error
   * instead of the broker's own answer. The endpoint belongs to the runtime's lifetime.
   */
  async listen(): Promise<void> {
    await this.start();
  }

  async register(
    environment: ChatGptTurnEnvironment,
    ttlMs?: number,
    traceId = "unknown",
    onProgress?: () => void,
    externalOwner = false,
    handlePrefix = "turn",
  ): Promise<string> {
    await this.start();
    this.prune();
    if (externalOwner && !this.acceptingExternalOwners) {
      throw new Error("turn broker is draining and does not accept new external owners");
    }
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new Error("ChatGPT web turn broker TTL must be a positive finite number");
    }
    const token = opaqueId(handlePrefix);
    const channel: TurnChannel = {
      traceId,
      externalOwner,
      ...(onProgress ? { onProgress } : {}),
      environment: {
        ...environment,
        ...(ttlMs !== undefined ? { expiresAt: Date.now() + ttlMs } : {}),
      },
      queuedCallIds: [],
      deliveredCallIds: new Set(),
      invocations: new Map(),
      waiters: new Set(),
      activities: new Set(),
      completedActivities: new Set(),
      activityRevision: 0,
      completionCommitted: false,
      compactionRequested: false,
      compactionDeliveryCount: 0,
      retirementWaiters: new Set(),
    };
    this.channels.set(token, channel);
    this.pending.set(token, channel);
    return token;
  }

  async registerSafe(
    environment: ChatGptTurnEnvironment, surfaceNonce: string, ttlMs?: number,
    traceId = "unknown", externalOwner = false,
  ): Promise<string> {
    const safe = createSafeTurn(surfaceNonce);
    const token = await this.register(environment, ttlMs, traceId, undefined, externalOwner, "request");
    const channel = this.channels.get(token);
    if (!channel) throw new Error("Zero Risk turn registration was revoked before initialization");
    channel.safe = safe;
    return token;
  }

  async registerContext(
    text: string,
    ttlMs?: number,
    traceId = "unknown",
    turnToken?: string,
  ): Promise<string> {
    await this.start();
    this.prune();
    return this.contexts.register(text, ttlMs, traceId, turnToken);
  }

  async beginCompactionTransaction(
    traceId: string,
    ttlMs = 120_000,
  ): Promise<CompactionTransactionHandle> {
    await this.start();
    return this.compactionTransactions.begin(traceId, ttlMs);
  }

  waitForCompactionHandoff(token: string, signal?: AbortSignal): Promise<string> {
    return this.compactionTransactions.wait(token, signal);
  }

  abortCompactionTransaction(token: string): void {
    this.compactionTransactions.abort(token);
  }

  revokeCompactionTransactions(traceId: string): void {
    this.compactionTransactions.abortTrace(traceId);
  }

  revokeContext(token: string): void {
    this.contexts.revoke(token);
  }

  updateEnvironment(token: string, environment: ChatGptTurnEnvironment): void {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    if (environmentIdentity(channel.environment) !== environmentIdentity(environment)) {
      throw new Error("Codex turn environment changed during an active ChatGPT tool loop");
    }
    if (channel.safe?.state === "revoked") throw new Error("Zero Risk turn is already terminal");
    if (channel.safe?.state === "completed") return;
    channel.environment = {
      ...environment,
      ...(channel.environment.expiresAt !== undefined
        ? { expiresAt: channel.environment.expiresAt }
        : {}),
    };
  }

  async nextToolBatch(token: string, signal?: AbortSignal): Promise<BrokerToolRequest[]> {
    this.prune();
    let channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    if (channel.safe?.state === "awaiting_start") {
      await waitSafeStart(channel, signal);
      channel = this.channels.get(token);
      if (!channel) throw new Error("turn token is invalid or expired");
    }
    if (channel.safe?.state === "completed") return [];
    assertSafeHarnessRunning(channel);
    if (channel.compactionRequested) {
      throw new Error("Codex context compaction superseded ordinary MCP tool delivery");
    }
    const ready = takeQueuedTools(channel);
    if (ready.length > 0) return ready;
    if (signal?.aborted) throw new DOMException("tool wait aborted", "AbortError");
    return new Promise<BrokerToolRequest[]>((resolveWait, rejectWait) => {
      const waiter: ToolWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          channel.waiters.delete(waiter);
          rejectWait(new DOMException("tool wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      channel.waiters.add(waiter);
    });
  }

  completeTool(token: string, callId: string, result: BrokerToolResult): void {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    assertSafeHarnessRunning(channel, true);
    const invocation = channel.invocations.get(callId);
    if (!invocation) throw new Error(`tool call is not pending: ${callId}`);
    if (!channel.deliveredCallIds.delete(callId)) throw new Error(`tool call was completed before it was delivered: ${callId}`);
    channel.invocations.delete(callId);
    console.info(`[chatgpt-web] broker trace=${channel.traceId} completed call=${callId.slice(0, 17)} pending=${channel.invocations.size}`);
    invocation.resolve(result);
  }

  beginCompletionFence(token: string): number | undefined {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    assertSafeHarnessRunning(channel);
    return beginTurnCompletionFence(channel);
  }

  commitCompletionFence(token: string, revision: number): boolean {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    const committed = commitTurnCompletionFence(channel, revision);
    if (committed) {
      console.info(`[chatgpt-web] broker trace=${channel.traceId} committed browser completion revision=${revision}`);
    }
    return committed;
  }

  waitForRetirement(token: string, signal?: AbortSignal): Promise<void> {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) return Promise.resolve();
    return waitForSafeState(channel.retirementWaiters, signal, "turn retirement wait aborted");
  }

  requestCompaction(token: string, queuedResult: BrokerToolResult): number {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    assertSafeHarnessRunning(channel);
    if (channel.compactionRequested) {
      throw new Error("Codex context compaction was already requested for this turn");
    }
    channel.compactionRequested = true;
    channel.compactionResult = structuredClone(queuedResult);
    if (channel.batchTimer) {
      clearTimeout(channel.batchTimer);
      channel.batchTimer = undefined;
    }
    const queued = channel.queuedCallIds.splice(0);
    for (const callId of queued) {
      const invocation = channel.invocations.get(callId);
      if (!invocation) continue;
      channel.invocations.delete(callId);
      channel.compactionDeliveryCount += 1;
      invocation.resolve(structuredClone(queuedResult));
    }
    return queued.length;
  }

  compactionDeliveryCount(token: string): number {
    const channel = this.channels.get(token);
    if (!channel) throw new Error("Cannot read compaction delivery after the turn capability retired");
    return channel.compactionDeliveryCount;
  }

  startSafeTurn(requestId: string): { started: true; duplicate: boolean } {
    this.prune();
    return startSafe(this.channels.get(requestId));
  }

  confirmSafeTurnSent(requestId: string, surfaceNonce: string): { confirmed: true; duplicate: boolean } {
    this.prune();
    return confirmSafeSent(this.channels.get(requestId), surfaceNonce);
  }

  completeSafeTurn(requestId: string, finalAnswer: string): { completed: true; duplicate: boolean } {
    this.prune();
    return completeSafe(this.channels.get(requestId), finalAnswer);
  }

  waitForSafeStart(requestId: string, signal?: AbortSignal): Promise<void> {
    this.prune();
    return waitSafeStart(this.channels.get(requestId), signal);
  }

  waitForSafeCompletion(requestId: string, signal?: AbortSignal): Promise<string> {
    this.prune();
    return waitSafeCompletion(this.channels.get(requestId), signal);
  }

  requestSteering(token: string, instruction: string): "queued" | "delivered" {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    channel.queuedCallIds.length = 0;
    if (channel.invocations.size === 0) {
      channel.steeringInstruction = channel.steeringInstruction
        ? `${channel.steeringInstruction}\n\n${instruction}`
        : instruction;
      return "queued";
    }
    const deliveredInstruction = channel.steeringInstruction
      ? `${channel.steeringInstruction}\n\n${instruction}`
      : instruction;
    channel.steeringInstruction = undefined;
    const result = steeringResult(deliveredInstruction);
    for (const [callId, invocation] of channel.invocations) {
      channel.invocations.delete(callId);
      invocation.resolve(result);
    }
    return "delivered";
  }

  takeUndeliveredSteering(token: string): string | undefined {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    const instruction = channel.steeringInstruction;
    channel.steeringInstruction = undefined;
    if (instruction) {
      console.info(`[chatgpt-web] broker trace=${channel.traceId} recovered undelivered native steering for same-conversation follow-up`);
    }
    return instruction;
  }

  revoke(token: string, reason = new Error("Codex turn binding was revoked")): void {
    const channel = this.channels.get(token);
    if (!channel) return;
    this.channels.delete(token);
    this.pending.delete(token);
    if (channel.bindingId) {
      this.bindings.delete(channel.bindingId);
      this.retire(this.retiredBindings, channel.bindingId, channel.traceId);
    }
    revokeSafeTurn(channel, reason);
    this.retire(this.retiredTokens, token, channel.traceId);
    resolveSafeWaiters(channel.retirementWaiters, undefined);
    rejectTurnChannel(channel, reason);
  }

  externalOwnerActiveCount(): number {
    this.prune();
    return [...this.channels.values()].filter(channel => channel.externalOwner).length;
  }

  revokeExternalOwners(): number {
    const tokens = [...this.channels]
      .filter(([, channel]) => channel.externalOwner)
      .map(([token]) => token);
    for (const token of tokens) this.revoke(token);
    return tokens.length;
  }

  revokeTrace(traceId: string, reason = new Error("Codex turn binding was revoked")): number {
    const tokens = [...this.channels]
      .filter(([, channel]) => channel.traceId === traceId)
      .map(([token]) => token);
    for (const token of tokens) this.revoke(token, reason);
    return tokens.length;
  }

  setExternalOwnersAccepted(accepted: boolean): void {
    this.acceptingExternalOwners = accepted;
  }

  private retire(history: Map<string, string>, handle: string, traceId: string): void {
    history.delete(handle);
    history.set(handle, traceId);
    while (history.size > MAX_RETIRED_TURN_HANDLES) {
      const oldest = history.keys().next();
      if (oldest.done) return;
      history.delete(oldest.value);
    }
  }

  async close(): Promise<void> {
    for (const token of [...this.channels.keys()]) this.revoke(token);
    this.contexts.clear();
    this.compactionTransactions.close();
    const server = this.server;
    this.server = undefined;
    this.startPromise = undefined;
    brokers.delete(this.socketPath);
    if (server?.listening) {
      await new Promise<void>((resolveClose, rejectClose) => server.close(error => {
        if (!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") resolveClose();
        else rejectClose(error);
      }));
    }
    if (!isWindowsPipeEndpoint(this.socketPath)
      && existsSync(this.socketPath)
      && lstatSync(this.socketPath).isSocket()) unlinkSync(this.socketPath);
  }

  private start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = startTurnBrokerServer(this.socketPath, (request, signal) => {
      this.prune();
      return dispatchTurnBrokerRequest(request, signal, {
        acceptingExternalOwners: () => this.acceptingExternalOwners,
        bindings: this.bindings,
        channels: this.channels,
        compactionTransactions: this.compactionTransactions,
        contexts: this.contexts,
        owner: this,
        pending: this.pending,
        registerExternal: (environment, ttlMs, traceId) => this.register(environment, ttlMs, traceId, undefined, true),
        registerExternalSafe: (environment, nonce, ttlMs, traceId) => this.registerSafe(environment, nonce, ttlMs, traceId, true),
        retiredBindings: this.retiredBindings,
        retiredTokens: this.retiredTokens,
        startSafeTurn: requestId => this.startSafeTurn(requestId),
        completeSafeTurn: (requestId, finalAnswer) => this.completeSafeTurn(requestId, finalAnswer),
      });
    })
      .then(server => { this.server = server; });
    return this.startPromise;
  }

  private prune(): void {
    const now = Date.now();
    this.contexts.prune(now);
    for (const [token, channel] of this.channels) {
      if (channel.environment.expiresAt === undefined || channel.environment.expiresAt > now) continue;
      this.revoke(token);
    }
  }
}
