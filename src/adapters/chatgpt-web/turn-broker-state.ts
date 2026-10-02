import type { ChatGptTurnEnvironment } from "./environment";
import { estimateTokens } from "../../lib/token-estimate";
import type { AgentWait } from "./turn-broker-agent-wait";
import type { BrokerRetirementFailure } from "./turn-broker-protocol";
import type { BrokerToolRequest, BrokerToolResult, BrokerTurnOutputEvent } from "./turn-broker-protocol";

export interface PendingTurn extends ChatGptTurnEnvironment {
  expiresAt?: number;
}

export interface PendingInvocation {
  request: BrokerToolRequest;
  resolve: (result: BrokerToolResult) => void;
  reject: (error: Error) => void;
}

export interface ToolWaiter {
  resolve: (requests: BrokerToolRequest[]) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface TurnOutputWaiter {
  afterSequence: number;
  resolve: (event: BrokerTurnOutputEvent) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export type SafeTurnState = "awaiting_start" | "running" | "completed" | "revoked";

export interface SafeWaiter<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface SafeTurnControl {
  state: SafeTurnState;
  surfaceNonce: string;
  launcherSent: boolean;
  connectorStarted: boolean;
  finalAnswer?: string;
  sentWaiters: Set<SafeWaiter<void>>;
  startWaiters: Set<SafeWaiter<void>>;
  completionWaiters: Set<SafeWaiter<string>>;
}

export interface TurnChannel {
  traceId: string;
  externalOwner: boolean;
  readonly outputEnabled: boolean;
  onProgress?: () => void;
  environment: PendingTurn;
  bindingId?: string;
  queuedCallIds: string[];
  deliveredCallIds: Set<string>;
  invocations: Map<string, PendingInvocation>;
  agentWait?: AgentWait;
  waiters: Set<ToolWaiter>;
  activities: Set<string>;
  completedActivities: Set<string>;
  activityRevision: number;
  completionCommitted: boolean;
  completionRevision?: number;
  retirementWaiters: Set<SafeWaiter<BrokerRetirementFailure | undefined>>;
  batchTimer?: ReturnType<typeof setTimeout>;
  compactionRequested: boolean;
  compactionResult?: BrokerToolResult;
  compactionDeliveryCount: number;
  onCompactionDelivered?: () => void;
  steeringInstruction?: string;
  outputEvents: BrokerTurnOutputEvent[];
  outputChars: number;
  outputWaiters: Set<TurnOutputWaiter>;
  outputResumeAfter: number;
  outputFinalSequence?: number;
  outputSealed: boolean;
  finalizationOnly: boolean;
  finalizationOutputArmed: boolean;
  finalizationPendingOutput?: BrokerTurnOutputEvent;
  safe?: SafeTurnControl;
}

export function notifyCompactionDelivery(channel: TurnChannel): void {
  const callback = channel.onCompactionDelivered;
  channel.onCompactionDelivered = undefined;
  callback?.();
}

export interface PendingContext {
  readonly text: string;
  sha256?: string;
  traceId: string;
  expiresAt?: number;
  turnToken?: string;
  nextChunk: number;
  chunkChars?: number;
  chunks?: string[];
  complete: boolean;
}

export function retiredTurnLabel(traceId: string): string {
  return traceId && traceId !== "unknown" ? `Codex turn ${traceId}` : "a Codex turn";
}

export function steeringResult(instruction: string): BrokerToolResult {
  return { content: [{
    type: "text",
    text: `${instruction}\n\nCodex steering notice: the pending tool result was superseded by the user's new instruction. This is a control message, not evidence that the command failed or succeeded. Continue with the new instruction and only rerun it if it remains necessary.`,
  }] };
}

export function completeArchiveChunks(text: string, limit: number, tokenLimit = Number.POSITIVE_INFINITY): string[] {
  if (!Number.isFinite(limit) || limit < 1 || tokenLimit < 1) {
    throw new Error("context archive chunk limits must be positive");
  }
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const chunks: string[] = [];
  let current = "";
  let currentTokens = 0;
  for (const line of lines) {
    const lineTokens = estimateTokens(line);
    if (line.length > limit || lineTokens > tokenLimit) {
      throw new Error(`context archive entry requires ${line.length} characters and ${lineTokens} tokens and exceeds the MCP chunk limit`);
    }
    if (current && (current.length + line.length > limit
      || currentTokens + lineTokens > tokenLimit)) {
      chunks.push(current);
      current = "";
      currentTokens = 0;
    }
    current += line;
    currentTokens += lineTokens;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function environmentIdentity(environment: ChatGptTurnEnvironment): string {
  return JSON.stringify({
    cwd: environment.cwd,
    roots: environment.roots,
    writableRoots: environment.writableRoots,
    sandboxPolicy: environment.sandboxPolicy,
  });
}
