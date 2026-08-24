import { existsSync, lstatSync, unlinkSync } from "node:fs";
import type { Server } from "node:net";
import { isWindowsPipeEndpoint } from "../../config";
import { CompactionTransactionStore, type CompactionTransactionHandle } from "./compaction-transaction";
import type { ChatGptTurnEnvironment } from "./environment";
import { startTurnBrokerServer } from "./turn-broker-server";
import { dispatchExternalOwnerRequest, type TurnBrokerOwner } from "./turn-broker-owner";
import {
  environmentIdentity,
  retiredTurnLabel,
  steeringResult,
  type ToolWaiter,
  type TurnChannel,
} from "./turn-broker-state";
import { opaqueId, type BrokerRequest, type BrokerToolRequest, type BrokerToolResult } from "./turn-broker-protocol";
import { TurnContextStore } from "./turn-context-store";

export { callTurnBroker } from "./turn-broker-client";
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
  ): Promise<string> {
    await this.start();
    this.prune();
    if (externalOwner && !this.acceptingExternalOwners) {
      throw new Error("turn broker is draining and does not accept new external owners");
    }
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new Error("ChatGPT web turn broker TTL must be a positive finite number");
    }
    const token = opaqueId("turn");
    const channel: TurnChannel = {
      traceId,
      externalOwner,
      ...(onProgress ? { onProgress } : {}),
      environment: {
        ...environment,
        ...(ttlMs !== undefined ? { expiresAt: Date.now() + ttlMs } : {}),
      },
      queuedCallIds: [],
      invocations: new Map(),
      waiters: new Set(),
    };
    this.channels.set(token, channel);
    this.pending.set(token, channel);
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
    channel.environment = {
      ...environment,
      ...(channel.environment.expiresAt !== undefined
        ? { expiresAt: channel.environment.expiresAt }
        : {}),
    };
  }

  async nextToolBatch(token: string, signal?: AbortSignal): Promise<BrokerToolRequest[]> {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    const ready = this.takeQueued(channel);
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
    const invocation = channel.invocations.get(callId);
    if (!invocation) throw new Error(`tool call is not pending: ${callId}`);
    if (channel.queuedCallIds.includes(callId)) throw new Error(`tool call was completed before it was delivered: ${callId}`);
    channel.invocations.delete(callId);
    console.info(`[chatgpt-web] broker trace=${channel.traceId} completed call=${callId.slice(0, 17)} pending=${channel.invocations.size}`);
    invocation.resolve(result);
  }

  requestHandoff(token: string, instruction: string): "queued" | "delivered" {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    const delivered = channel.invocations.size > 0;
    channel.handoffInstruction = instruction;
    channel.queuedCallIds.length = 0;
    for (const [callId, invocation] of channel.invocations) {
      channel.invocations.delete(callId);
      invocation.resolve({ content: [{ type: "text", text: instruction }], isError: true });
    }
    return delivered ? "delivered" : "queued";
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

  handoffRequested(token: string): boolean {
    this.prune();
    return Boolean(this.channels.get(token)?.handoffInstruction);
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
    this.retire(this.retiredTokens, token, channel.traceId);
    this.rejectChannel(channel, reason);
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
    this.startPromise = startTurnBrokerServer(this.socketPath, request => this.dispatch(request))
      .then(server => { this.server = server; });
    return this.startPromise;
  }

  private dispatch(request: BrokerRequest): unknown | Promise<unknown> {
    this.prune();
    if (request.method.startsWith("owner_")) return dispatchExternalOwnerRequest(request, {
      accepting: () => this.acceptingExternalOwners,
      registerExternal: (environment, ttlMs, traceId) => this.register(environment, ttlMs, traceId, undefined, true),
      register: (environment, ttlMs, traceId) => this.register(environment, ttlMs, traceId),
      updateEnvironment: (token, environment) => this.updateEnvironment(token, environment),
      nextToolBatch: (token, signal) => this.nextToolBatch(token, signal),
      completeTool: (token, callId, result) => this.completeTool(token, callId, result),
      revoke: (token, reason) => this.revoke(token, reason),
    });
    if (request.method === "submit_compaction_handoff") {
      const token = request.token;
      const handoffId = request.handoffId;
      const summary = request.summary;
      if (typeof token !== "string" || token.length === 0) throw new Error("compaction control token is required");
      if (typeof handoffId !== "string" || handoffId.length === 0) throw new Error("compaction handoff id is required");
      if (typeof summary !== "string") throw new Error("compaction handoff summary is required");
      this.compactionTransactions.submit(token, handoffId, summary);
      return { submitted: true };
    }
    if (request.method === "read_context") {
      const token = request.token;
      if (typeof token !== "string" || token.length === 0) throw new Error("context token is required");
      return this.contexts.read(token, request.index, request.chunkChars, this.channels);
    }
    if (request.method === "claim") {
      const token = request.token;
      if (typeof token !== "string" || token.length === 0) throw new Error("turn token is required");
      const channel = this.channels.get(token);
      const retiredTurn = channel ? undefined : this.retiredTokens.get(token);
      console.error(
        `[chatgpt-web] broker claim received (tokenChars=${token.length}, valid=${Boolean(channel)}`
        + `${channel ? "" : `, retiredTurn=${retiredTurn ?? "unknown"}`})`,
      );
      if (!channel) {
        throw new Error(retiredTurn !== undefined
          ? `This turn_token was issued for ${retiredTurnLabel(retiredTurn)}, which has already finished.`
          + " This Codex Native action can no longer run."
          : "turn token is invalid, expired, or revoked");
      }
      if (this.contexts.hasIncomplete(token)) {
        throw new Error("Read and verify the complete Codex context archive before calling work tools");
      }
      if (channel.bindingId) {
        const existing = this.bindings.get(channel.bindingId);
        if (!existing || existing.token !== token || existing.channel !== channel) {
          throw new Error("turn token binding state is inconsistent");
        }
        return { bindingId: channel.bindingId, environment: channel.environment };
      }
      this.pending.delete(token);
      const bindingId = opaqueId("binding");
      channel.bindingId = bindingId;
      this.bindings.set(bindingId, { token, channel });
      return { bindingId, environment: channel.environment };
    }

    const bindingId = request.bindingId;
    if (typeof bindingId !== "string" || bindingId.length === 0) throw new Error("binding id is required");
    const binding = this.bindings.get(bindingId);
    if (!binding) {
      const retiredTurn = this.retiredBindings.get(bindingId);
      console.error(
        `[chatgpt-web] broker rejected ${request.method} (binding=${bindingId.slice(0, 17)},`
        + ` retiredTurn=${retiredTurn ?? "unknown"})`,
      );
      throw new Error(retiredTurn !== undefined
        ? `${retiredTurnLabel(retiredTurn)} has already finished; this Codex Native action can no longer run.`
        : "internal Codex turn binding is invalid or expired");
    }
    if (request.method === "release") {
      this.revoke(binding.token);
      return { released: true };
    }
    if (request.method === "resolve") return { environment: binding.channel.environment };

    if (binding.channel.handoffInstruction) {
      return {
        content: [{ type: "text", text: binding.channel.handoffInstruction }],
        isError: true,
      } satisfies BrokerToolResult;
    }

    if (binding.channel.steeringInstruction) {
      const instruction = binding.channel.steeringInstruction;
      binding.channel.steeringInstruction = undefined;
      console.info(`[chatgpt-web] broker trace=${binding.channel.traceId} delivered queued native steering through the tool loop`);
      return steeringResult(instruction);
    }

    const wireName = request.wireName?.trim();
    if (!wireName) throw new Error("wire tool name is required");
    const callId = opaqueId("call");
    const toolRequest: BrokerToolRequest = {
      callId,
      wireName,
      freeform: request.freeform === true,
      ...(request.freeform === true ? { input: request.input ?? "" } : { arguments: request.arguments ?? {} }),
    };
    return new Promise<BrokerToolResult>((resolveInvoke, rejectInvoke) => {
      binding.channel.invocations.set(callId, { request: toolRequest, resolve: resolveInvoke, reject: rejectInvoke });
      binding.channel.queuedCallIds.push(callId);
      console.info(
        `[chatgpt-web] broker trace=${binding.channel.traceId} queued call=${callId.slice(0, 17)} tool=${wireName} waiters=${binding.channel.waiters.size}`,
      );
      this.scheduleToolWaiters(binding.channel);
    });
  }

  private takeQueued(channel: TurnChannel): BrokerToolRequest[] {
    const ids = channel.queuedCallIds.splice(0);
    return ids.map(id => channel.invocations.get(id)?.request).filter((request): request is BrokerToolRequest => Boolean(request));
  }

  private scheduleToolWaiters(channel: TurnChannel): void {
    if (channel.queuedCallIds.length === 0 || channel.waiters.size === 0) return;
    if (channel.batchTimer) return;
    channel.batchTimer = setTimeout(() => {
      channel.batchTimer = undefined;
      this.wakeToolWaiters(channel);
    }, 15);
  }

  private wakeToolWaiters(channel: TurnChannel): void {
    if (channel.queuedCallIds.length === 0 || channel.waiters.size === 0) return;
    const batch = this.takeQueued(channel);
    console.info(
      `[chatgpt-web] broker trace=${channel.traceId} delivered calls=${batch.length} tools=${batch.map(request => request.wireName).join(",")}`,
    );
    const waiters = [...channel.waiters];
    channel.waiters.clear();
    const first = waiters.shift();
    if (first) {
      if (first.signal && first.onAbort) first.signal.removeEventListener("abort", first.onAbort);
      first.resolve(batch);
    }
    for (const waiter of waiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(new Error("another adapter waiter already claimed the queued tool batch"));
    }
  }

  private rejectChannel(channel: TurnChannel, error: Error): void {
    if (channel.batchTimer) clearTimeout(channel.batchTimer);
    channel.batchTimer = undefined;
    for (const waiter of channel.waiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
    channel.waiters.clear();
    for (const invocation of channel.invocations.values()) invocation.reject(error);
    channel.invocations.clear();
    channel.queuedCallIds = [];
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
