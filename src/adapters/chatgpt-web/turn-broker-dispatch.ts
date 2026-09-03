import type { CompactionTransactionStore } from "./compaction-transaction";
import type { TurnContextStore } from "./turn-context-store";
import {
  assertTurnActivityId,
  claimTurnActivity,
  completeTurnActivity,
} from "./turn-broker-completion";
import { dispatchExternalOwnerRequest, type TurnBrokerOwner } from "./turn-broker-owner";
import { scheduleToolWaiters } from "./turn-broker-queue";
import {
  assertSafeHarnessRunning,
  waitForSafeSent,
} from "./turn-broker-safe";
import {
  retiredTurnLabel,
  steeringResult,
  type TurnChannel,
} from "./turn-broker-state";
import {
  opaqueId,
  type BrokerRequest,
  type BrokerToolRequest,
  type BrokerToolResult,
} from "./turn-broker-protocol";

interface DispatchState {
  acceptingExternalOwners(): boolean;
  bindings: Map<string, { token: string; channel: TurnChannel }>;
  channels: Map<string, TurnChannel>;
  compactionTransactions: CompactionTransactionStore;
  contexts: TurnContextStore;
  owner: TurnBrokerOwner;
  pending: Map<string, TurnChannel>;
  registerExternal: TurnBrokerOwner["register"];
  registerExternalSafe: TurnBrokerOwner["registerSafe"];
  retiredBindings: Map<string, string>;
  retiredTokens: Map<string, string>;
  startSafeTurn(requestId: string): { started: true; duplicate: boolean };
  completeSafeTurn(requestId: string, finalAnswer: string): { completed: true; duplicate: boolean };
}

export async function dispatchTurnBrokerRequest(
  request: BrokerRequest,
  signal: AbortSignal,
  state: DispatchState,
): Promise<unknown> {
  const { owner } = state;
  if (request.method === "safe_start") {
    if (!request.token) throw new Error("Zero Risk request_id is required");
    return state.startSafeTurn(request.token);
  }
  if (request.method === "safe_complete") {
    if (!request.token) throw new Error("Zero Risk request_id is required");
    if (typeof request.finalAnswer !== "string") throw new Error("Zero Risk turn final_answer is required");
    const channel = state.channels.get(request.token);
    if (channel?.safe?.state === "awaiting_start" && !channel.safe.launcherSent) {
      await waitForSafeSent(channel, signal);
    }
    return state.completeSafeTurn(request.token, request.finalAnswer);
  }
  if (request.method.startsWith("owner_")) return dispatchExternalOwnerRequest(request, {
    accepting: state.acceptingExternalOwners,
    registerExternal: state.registerExternal,
    registerExternalSafe: state.registerExternalSafe,
    register: owner.register.bind(owner),
    registerSafe: owner.registerSafe.bind(owner),
    updateEnvironment: owner.updateEnvironment.bind(owner),
    confirmSafeTurnSent: owner.confirmSafeTurnSent.bind(owner),
    nextToolBatch: owner.nextToolBatch.bind(owner),
    completeTool: owner.completeTool.bind(owner),
    waitForSafeStart: owner.waitForSafeStart.bind(owner),
    waitForSafeCompletion: owner.waitForSafeCompletion.bind(owner),
    requestCompaction: owner.requestCompaction.bind(owner),
    compactionDeliveryCount: owner.compactionDeliveryCount.bind(owner),
    beginCompletionFence: owner.beginCompletionFence.bind(owner),
    commitCompletionFence: owner.commitCompletionFence.bind(owner),
    revoke: owner.revoke.bind(owner),
  }, signal);
  if (request.method === "submit_compaction_handoff") {
    if (typeof request.token !== "string" || request.token.length === 0) throw new Error("compaction control token is required");
    if (typeof request.handoffId !== "string" || request.handoffId.length === 0) throw new Error("compaction handoff id is required");
    if (typeof request.summary !== "string") throw new Error("compaction handoff summary is required");
    state.compactionTransactions.submit(request.token, request.handoffId, request.summary);
    return { submitted: true };
  }
  if (request.method === "read_context") {
    if (typeof request.token !== "string" || request.token.length === 0) throw new Error("context token is required");
    return state.contexts.read(request.token, request.index, request.chunkChars, state.channels);
  }
  if (request.method === "claim") return claim(request, signal, state);
  if (request.method === "activity_complete") {
    if (typeof request.token !== "string" || request.token.length === 0) throw new Error("turn token is required");
    assertTurnActivityId(request.activityId);
    const channel = state.channels.get(request.token);
    if (!channel) return { completed: false, retired: state.retiredTokens.has(request.token) };
    if (channel.completedActivities.has(request.activityId)) return { completed: false, duplicate: true };
    return { completed: completeTurnActivity(channel, request.activityId) };
  }
  return invoke(request, state);
}

async function claim(request: BrokerRequest, signal: AbortSignal, state: DispatchState): Promise<unknown> {
  const contract = request.contract ?? "native";
  const token = request.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(contract === "safe" ? "request id is required" : "turn token is required");
  }
  const channel = state.channels.get(token);
  let activeChannel = channel && !channel.completionCommitted ? channel : undefined;
  const retiredTurn = channel?.completionCommitted ? channel.traceId : state.retiredTokens.get(token);
  console.error(
    `[chatgpt-web] broker claim received (tokenChars=${token.length}, valid=${Boolean(activeChannel)}`
    + `${activeChannel ? "" : `, retiredTurn=${retiredTurn ?? "unknown"}`})`,
  );
  if (!activeChannel) {
    throw new Error(retiredTurn !== undefined
      ? `This turn_token was issued for ${retiredTurnLabel(retiredTurn)}, which has already finished.`
      + " This Codex Native action can no longer run."
      : "turn token is invalid, expired, or revoked");
  }
  if (activeChannel.safe) {
    if (contract !== "safe") throw new Error("Zero Risk request id requires the Zero Risk MCP contract");
    if (activeChannel.safe.state === "awaiting_start" && !activeChannel.safe.launcherSent) {
      await waitForSafeSent(activeChannel, signal);
      activeChannel = state.channels.get(token);
      if (!activeChannel || activeChannel.completionCommitted) throw new Error("turn token is invalid, expired, or revoked");
    }
    assertSafeHarnessRunning(activeChannel);
  } else if (contract === "safe") {
    throw new Error("Zero Risk MCP contract requires a Zero Risk request id");
  }
  assertTurnActivityId(request.activityId);
  claimTurnActivity(activeChannel, request.activityId);
  if (state.contexts.hasIncomplete(token)) {
    throw new Error("Read and verify the complete Codex context archive before calling work tools");
  }
  if (activeChannel.bindingId) {
    const existing = state.bindings.get(activeChannel.bindingId);
    if (!existing || existing.token !== token || existing.channel !== activeChannel) {
      throw new Error("turn token binding state is inconsistent");
    }
    return { bindingId: activeChannel.bindingId, activityId: request.activityId, environment: activeChannel.environment };
  }
  state.pending.delete(token);
  const bindingId = opaqueId("binding");
  activeChannel.bindingId = bindingId;
  state.bindings.set(bindingId, { token, channel: activeChannel });
  return { bindingId, activityId: request.activityId, environment: activeChannel.environment };
}

function invoke(request: BrokerRequest, state: DispatchState): unknown {
  const bindingId = request.bindingId;
  if (typeof bindingId !== "string" || bindingId.length === 0) throw new Error("binding id is required");
  const binding = state.bindings.get(bindingId);
  if (!binding) {
    const retiredTurn = state.retiredBindings.get(bindingId);
    console.error(`[chatgpt-web] broker rejected ${request.method} (binding=${bindingId.slice(0, 17)}, retiredTurn=${retiredTurn ?? "unknown"})`);
    throw new Error(retiredTurn !== undefined
      ? `${retiredTurnLabel(retiredTurn)} has already finished; this Codex Native action can no longer run.`
      : "internal Codex turn binding is invalid or expired");
  }
  if (request.method === "release") {
    state.owner.revoke(binding.token);
    return { released: true };
  }
  if (request.method === "resolve") return { environment: binding.channel.environment };
  assertSafeHarnessRunning(binding.channel);
  if (binding.channel.compactionRequested) {
    const result = binding.channel.compactionResult;
    if (!result) throw new Error("Codex context compaction control result is unavailable");
    binding.channel.compactionDeliveryCount += 1;
    return structuredClone(result);
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
  return new Promise<BrokerToolResult>((resolve, reject) => {
    binding.channel.invocations.set(callId, { request: toolRequest, resolve, reject });
    binding.channel.queuedCallIds.push(callId);
    console.info(`[chatgpt-web] broker trace=${binding.channel.traceId} queued call=${callId.slice(0, 17)} tool=${wireName} waiters=${binding.channel.waiters.size}`);
    scheduleToolWaiters(binding.channel);
  });
}
