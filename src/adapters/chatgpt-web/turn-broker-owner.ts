import { isAbsolute, relative, resolve } from "node:path";
import type { ChatGptTurnEnvironment } from "./environment";
import { callTurnBroker } from "./turn-broker-client";
import type { BrokerRequest, BrokerToolRequest, BrokerToolResult, BrokerTurnOutputEvent } from "./turn-broker-protocol";
import { assertSurfaceNonce } from "./turn-broker-safe";

export interface TurnBrokerOwner {
  register(
    environment: ChatGptTurnEnvironment,
    ttlMs?: number,
    traceId?: string,
    onProgress?: () => void,
    outputEnabled?: boolean,
  ): Promise<string>;
  registerSafe(environment: ChatGptTurnEnvironment, surfaceNonce: string, ttlMs?: number, traceId?: string): Promise<string>;
  updateEnvironment(token: string, environment: ChatGptTurnEnvironment): void | Promise<void>;
  confirmSafeTurnSent(token: string, surfaceNonce: string): { confirmed: true; duplicate: boolean } | Promise<{ confirmed: true; duplicate: boolean }>;
  nextToolBatch(token: string, signal?: AbortSignal): Promise<BrokerToolRequest[]>;
  completeTool(token: string, callId: string, result: BrokerToolResult): void | Promise<void>;
  waitForSafeStart(token: string, signal?: AbortSignal): Promise<void>;
  waitForSafeCompletion(token: string, signal?: AbortSignal): Promise<string>;
  requestCompaction(token: string, result: BrokerToolResult): number | Promise<number>;
  compactionDeliveryCount(token: string): number | Promise<number>;
  beginCompletionFence(token: string): number | undefined | Promise<number | undefined>;
  commitCompletionFence(token: string, revision: number): boolean | Promise<boolean>;
  nextOutput(token: string, afterSequence: number, signal?: AbortSignal): Promise<BrokerTurnOutputEvent>;
  resetOutput(token: string, finalSequence: number): void | Promise<void>;
  sealOutput(token: string, afterSequence: number): boolean | Promise<boolean>;
  waitForRetirement(token: string, signal?: AbortSignal): Promise<void>;
  revoke(token: string, reason?: Error): void | Promise<void>;
}

export interface ExternalOwnerDispatchTarget extends TurnBrokerOwner {
  accepting(): boolean;
  registerExternal(
    environment: ChatGptTurnEnvironment,
    ttlMs?: number,
    traceId?: string,
    onProgress?: () => void,
    outputEnabled?: boolean,
  ): Promise<string>;
  registerExternalSafe(environment: ChatGptTurnEnvironment, surfaceNonce: string, ttlMs?: number, traceId?: string): Promise<string>;
}

export function dispatchExternalOwnerRequest(
  request: BrokerRequest,
  target: ExternalOwnerDispatchTarget,
  signal?: AbortSignal,
): unknown | Promise<unknown> {
  if (request.method === "owner_status") {
    return { protocolVersion: 6, acceptingExternalOwners: target.accepting() };
  }
  if (request.method === "owner_register") {
    const environment = ownerEnvironment(request.environment);
    if (request.traceId !== undefined && !/^[A-Za-z0-9_-]{6,128}$/.test(request.traceId)) {
      throw new Error("turn owner trace id is invalid");
    }
    if (request.outputEnabled !== undefined && typeof request.outputEnabled !== "boolean") {
      throw new Error("turn owner output capability is invalid");
    }
    return target.registerExternal(
      environment, request.ttlMs, request.traceId, undefined, request.outputEnabled === true,
    ).then(token => ({ token }));
  }
  if (request.method === "owner_register_safe") {
    const environment = ownerEnvironment(request.environment);
    assertSurfaceNonce(request.surfaceNonce);
    if (request.traceId !== undefined && !/^[A-Za-z0-9_-]{6,128}$/.test(request.traceId)) {
      throw new Error("turn owner trace id is invalid");
    }
    return target.registerExternalSafe(environment, request.surfaceNonce, request.ttlMs, request.traceId)
      .then(token => ({ token }));
  }
  if (!request.token) throw new Error("turn owner token is required");
  if (request.method === "owner_update") {
    target.updateEnvironment(request.token, ownerEnvironment(request.environment));
    return { updated: true };
  }
  if (request.method === "owner_safe_sent") {
    assertSurfaceNonce(request.surfaceNonce);
    return target.confirmSafeTurnSent(request.token, request.surfaceNonce);
  }
  if (request.method === "owner_next") {
    return target.nextToolBatch(request.token, signal).then(requests => ({ requests }));
  }
  if (request.method === "owner_complete") {
    if (!request.callId) throw new Error("turn owner call id is required");
    if (!request.toolResult || !Array.isArray(request.toolResult.content)) {
      throw new Error("turn owner tool result is invalid");
    }
    target.completeTool(request.token, request.callId, request.toolResult);
    return { completed: true };
  }
  if (request.method === "owner_safe_wait_start") {
    return target.waitForSafeStart(request.token, signal).then(() => ({ started: true }));
  }
  if (request.method === "owner_safe_wait_completion") {
    return target.waitForSafeCompletion(request.token, signal).then(finalAnswer => ({ finalAnswer }));
  }
  if (request.method === "owner_request_compaction") {
    if (!request.toolResult || !Array.isArray(request.toolResult.content)) {
      throw new Error("turn owner compaction result is invalid");
    }
    return Promise.resolve(target.requestCompaction(request.token, request.toolResult))
      .then(interrupted => ({ interrupted }));
  }
  if (request.method === "owner_compaction_delivery_count") {
    return Promise.resolve(target.compactionDeliveryCount(request.token)).then(count => ({ count }));
  }
  if (request.method === "owner_completion_fence_begin") {
    return Promise.resolve(target.beginCompletionFence(request.token)).then(revision => ({ revision: revision ?? null }));
  }
  if (request.method === "owner_completion_fence_commit") {
    if (!Number.isSafeInteger(request.revision) || request.revision! < 0) {
      throw new Error("turn completion fence revision is invalid");
    }
    return Promise.resolve(target.commitCompletionFence(request.token, request.revision!))
      .then(committed => ({ committed }));
  }
  if (request.method === "owner_next_output") {
    if (!Number.isSafeInteger(request.afterSequence) || request.afterSequence! < 0) {
      throw new Error("turn output sequence is invalid");
    }
    return target.nextOutput(request.token, request.afterSequence!, signal).then(event => ({ event }));
  }
  if (request.method === "owner_reset_output") {
    if (!Number.isSafeInteger(request.outputSequence) || request.outputSequence! <= 0) {
      throw new Error("turn output reset sequence is invalid");
    }
    return Promise.resolve(target.resetOutput(request.token, request.outputSequence!)).then(() => ({ reset: true }));
  }
  if (request.method === "owner_seal_output") {
    if (!Number.isSafeInteger(request.afterSequence) || request.afterSequence! < 0) {
      throw new Error("turn output seal sequence is invalid");
    }
    return Promise.resolve(target.sealOutput(request.token, request.afterSequence!)).then(sealed => ({ sealed }));
  }
  if (request.method === "owner_wait_retirement") {
    return target.waitForRetirement(request.token, signal).then(() => ({ retired: true }));
  }
  if (request.method === "owner_revoke") {
    target.revoke(request.token);
    return { revoked: true };
  }
  throw new Error("turn owner method is invalid");
}

export function ownerEnvironment(value: unknown): ChatGptTurnEnvironment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("turn owner environment is invalid");
  }
  const environment = value as Partial<ChatGptTurnEnvironment>;
  const paths = (candidate: unknown): candidate is string[] => Array.isArray(candidate)
    && candidate.length > 0
    && candidate.every(path => typeof path === "string" && isAbsolute(path));
  if (typeof environment.cwd !== "string" || !isAbsolute(environment.cwd)
    || !paths(environment.roots) || !Array.isArray(environment.writableRoots)
    || environment.writableRoots.some(path => typeof path !== "string" || !isAbsolute(path))
    || !environment.roots.some(root => {
      const nested = relative(resolve(root), resolve(environment.cwd!));
      return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
    })
    || !environment.sandboxPolicy
    || !["dangerFullAccess", "workspaceWrite", "readOnly"].includes(environment.sandboxPolicy.type)
    || !Array.isArray(environment.tools)
    || environment.tools.some(tool => !tool || typeof tool.name !== "string"
      || typeof tool.description !== "string" || !tool.parameters
      || typeof tool.parameters !== "object" || Array.isArray(tool.parameters))) {
    throw new Error("turn owner environment is invalid");
  }
  return structuredClone(environment as ChatGptTurnEnvironment);
}

/** Client for an external DEV harness that borrows the launcher's live turn broker. */
export class RemoteTurnBroker implements TurnBrokerOwner {
  constructor(readonly socketPath: string) {}

  async waitForRetirement(token: string, signal?: AbortSignal): Promise<void> {
    const result = await callTurnBroker<{ retired?: unknown }>(this.socketPath, { method: "owner_wait_retirement", token }, null, signal);
    if (result.retired !== true) throw new Error("DEV turn owner received an invalid retirement result");
  }

  async assertCompatible(): Promise<void> {
    let status: { protocolVersion?: unknown; acceptingExternalOwners?: unknown };
    try {
      status = await callTurnBroker(this.socketPath, { method: "owner_status" });
    } catch (error) {
      throw new Error(
        "The running launcher runtime does not expose the DEV turn-owner protocol; update and restart Codex Web GPT once before using the working-tree DEV chat"
        + ` (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (status.protocolVersion !== 6) {
      throw new Error(`Unsupported DEV turn-owner protocol version: ${String(status.protocolVersion)}`);
    }
    if (status.acceptingExternalOwners !== true) {
      throw new Error("The running launcher runtime is draining and is not accepting DEV chat turns");
    }
  }

  async register(
    environment: ChatGptTurnEnvironment,
    ttlMs?: number,
    traceId = "unknown",
    _onProgress?: () => void,
    outputEnabled = false,
  ): Promise<string> {
    const response = await callTurnBroker<{ token?: unknown }>(this.socketPath, {
      method: "owner_register",
      environment,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      ...(traceId !== "unknown" ? { traceId } : {}),
      ...(outputEnabled ? { outputEnabled: true } : {}),
    });
    if (typeof response.token !== "string" || !response.token.startsWith("turn_")) {
      throw new Error("DEV turn owner received an invalid broker token");
    }
    return response.token;
  }

  async registerSafe(
    environment: ChatGptTurnEnvironment,
    surfaceNonce: string,
    ttlMs?: number,
    traceId = "unknown",
  ): Promise<string> {
    assertSurfaceNonce(surfaceNonce);
    const response = await callTurnBroker<{ token?: unknown }>(this.socketPath, {
      method: "owner_register_safe", environment, surfaceNonce,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      ...(traceId !== "unknown" ? { traceId } : {}),
    });
    if (typeof response.token !== "string" || !response.token.startsWith("request_")) {
      throw new Error("DEV Zero Risk turn owner received an invalid broker request id");
    }
    return response.token;
  }

  async updateEnvironment(token: string, environment: ChatGptTurnEnvironment): Promise<void> {
    await callTurnBroker(this.socketPath, { method: "owner_update", token, environment });
  }

  async confirmSafeTurnSent(token: string, surfaceNonce: string): Promise<{ confirmed: true; duplicate: boolean }> {
    const response = await callTurnBroker<{ confirmed?: unknown; duplicate?: unknown }>(this.socketPath, {
      method: "owner_safe_sent", token, surfaceNonce,
    });
    if (response.confirmed !== true || typeof response.duplicate !== "boolean") {
      throw new Error("DEV Zero Risk turn owner received an invalid Sent confirmation result");
    }
    return { confirmed: true, duplicate: response.duplicate };
  }

  async nextToolBatch(token: string, signal?: AbortSignal): Promise<BrokerToolRequest[]> {
    const response = await callTurnBroker<{ requests?: unknown }>(
      this.socketPath,
      { method: "owner_next", token },
      null,
      signal,
    );
    if (!Array.isArray(response.requests) || response.requests.some(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return true;
      const request = value as Partial<BrokerToolRequest>;
      return typeof request.callId !== "string" || typeof request.wireName !== "string"
        || typeof request.freeform !== "boolean"
        || (request.freeform ? typeof request.input !== "string"
          : !request.arguments || typeof request.arguments !== "object" || Array.isArray(request.arguments));
    })) throw new Error("DEV turn owner received an invalid tool batch");
    return response.requests as BrokerToolRequest[];
  }

  async completeTool(token: string, callId: string, result: BrokerToolResult): Promise<void> {
    await callTurnBroker(this.socketPath, {
      method: "owner_complete",
      token,
      callId,
      toolResult: result,
    }, null);
  }

  async waitForSafeStart(token: string, signal?: AbortSignal): Promise<void> {
    const response = await callTurnBroker<{ started?: unknown }>(
      this.socketPath, { method: "owner_safe_wait_start", token }, null, signal,
    );
    if (response.started !== true) throw new Error("DEV Zero Risk turn owner received an invalid start result");
  }

  async waitForSafeCompletion(token: string, signal?: AbortSignal): Promise<string> {
    const response = await callTurnBroker<{ finalAnswer?: unknown }>(
      this.socketPath, { method: "owner_safe_wait_completion", token }, null, signal,
    );
    if (typeof response.finalAnswer !== "string" || response.finalAnswer.trim().length === 0) {
      throw new Error("DEV Zero Risk turn owner received an invalid completion result");
    }
    return response.finalAnswer;
  }

  async requestCompaction(token: string, result: BrokerToolResult): Promise<number> {
    const response = await callTurnBroker<{ interrupted?: unknown }>(
      this.socketPath, { method: "owner_request_compaction", token, toolResult: result }, null,
    );
    if (!Number.isSafeInteger(response.interrupted) || Number(response.interrupted) < 0) {
      throw new Error("DEV Zero Risk turn owner received an invalid compaction interrupt count");
    }
    return Number(response.interrupted);
  }

  async compactionDeliveryCount(token: string): Promise<number> {
    const response = await callTurnBroker<{ count?: unknown }>(this.socketPath, {
      method: "owner_compaction_delivery_count", token,
    });
    if (!Number.isSafeInteger(response.count) || Number(response.count) < 0) {
      throw new Error("DEV Zero Risk turn owner received an invalid compaction delivery count");
    }
    return Number(response.count);
  }

  async beginCompletionFence(token: string): Promise<number | undefined> {
    const response = await callTurnBroker<{ revision?: unknown }>(this.socketPath, {
      method: "owner_completion_fence_begin",
      token,
    });
    if (response.revision === null) return undefined;
    if (!Number.isSafeInteger(response.revision) || (response.revision as number) < 0) {
      throw new Error("DEV turn owner received an invalid completion fence revision");
    }
    return response.revision as number;
  }

  async commitCompletionFence(token: string, revision: number): Promise<boolean> {
    const response = await callTurnBroker<{ committed?: unknown }>(this.socketPath, {
      method: "owner_completion_fence_commit",
      token,
      revision,
    });
    if (typeof response.committed !== "boolean") {
      throw new Error("DEV turn owner received an invalid completion fence result");
    }
    return response.committed;
  }

  async nextOutput(token: string, afterSequence: number, signal?: AbortSignal): Promise<BrokerTurnOutputEvent> {
    const response = await callTurnBroker<{ event?: unknown }>(this.socketPath, {
      method: "owner_next_output", token, afterSequence,
    }, null, signal);
    return assertBrokerTurnOutputEvent(response.event);
  }

  async resetOutput(token: string, finalSequence: number): Promise<void> {
    const response = await callTurnBroker<{ reset?: unknown }>(this.socketPath, {
      method: "owner_reset_output", token, outputSequence: finalSequence,
    });
    if (response.reset !== true) throw new Error("DEV turn owner received an invalid output reset result");
  }

  async sealOutput(token: string, afterSequence: number): Promise<boolean> {
    const response = await callTurnBroker<{ sealed?: unknown }>(this.socketPath, {
      method: "owner_seal_output", token, afterSequence,
    });
    if (typeof response.sealed !== "boolean") throw new Error("DEV turn owner received an invalid output seal result");
    return response.sealed;
  }

  async revoke(token: string, _reason?: Error): Promise<void> {
    await callTurnBroker(this.socketPath, { method: "owner_revoke", token });
  }
}

function assertBrokerTurnOutputEvent(value: unknown): BrokerTurnOutputEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DEV turn owner received invalid output");
  const event = value as Partial<BrokerTurnOutputEvent>;
  if (!Number.isSafeInteger(event.sequence) || event.sequence! <= 0
    || !["commentary", "reasoning", "final"].includes(String(event.kind))
    || typeof event.text !== "string" || event.text.length === 0) {
    throw new Error("DEV turn owner received invalid output");
  }
  return event as BrokerTurnOutputEvent;
}
