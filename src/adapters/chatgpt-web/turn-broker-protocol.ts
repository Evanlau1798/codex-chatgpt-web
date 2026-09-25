import { randomBytes } from "node:crypto";
import type { ChatGptTurnEnvironment } from "./environment";

export interface BrokerToolRequest {
  callId: string;
  wireName: string;
  freeform: boolean;
  invokeDeadlineAt?: number;
  arguments?: Record<string, unknown>;
  input?: string;
}

export interface BrokerToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: unknown;
}

export type BrokerTurnOutputKind = "commentary" | "reasoning" | "final";

export interface BrokerTurnOutputEvent {
  sequence: number;
  kind: BrokerTurnOutputKind;
  text: string;
}

export interface BrokerRequest {
  id: string;
  method: "claim" | "resolve" | "release" | "invoke" | "read_context" | "submit_compaction_handoff" | "submit_recovery_checkpoint" | "submit_output"
    | "owner_status" | "owner_register" | "owner_register_safe" | "owner_update" | "owner_safe_sent"
    | "owner_next" | "owner_complete" | "owner_safe_wait_start" | "owner_safe_wait_completion"
    | "owner_request_compaction" | "owner_compaction_delivery_count" | "safe_start" | "safe_complete"
    | "owner_completion_fence_begin" | "owner_completion_fence_commit" | "owner_next_output"
    | "owner_reset_output" | "owner_seal_output" | "owner_wait_retirement" | "owner_revoke" | "activity_complete"
    | "start_agent_wait" | "read_agent_wait";
  waitId?: string;
  token?: string;
  bindingId?: string;
  wireName?: string;
  freeform?: boolean;
  arguments?: Record<string, unknown>;
  input?: string;
  invokeDeadlineAt?: number;
  handoffId?: string;
  summary?: string;
  index?: number;
  chunkChars?: number;
  environment?: ChatGptTurnEnvironment;
  ttlMs?: number;
  traceId?: string;
  callId?: string;
  activityId?: string;
  revision?: number;
  toolResult?: BrokerToolResult;
  surfaceNonce?: string;
  finalAnswer?: string;
  outputKind?: BrokerTurnOutputKind;
  outputText?: string;
  outputEnabled?: boolean;
  afterSequence?: number;
  expectedRevision?: number;
  outputSequence?: number;
  contract?: "native" | "safe";
}

export interface BrokerResponse {
  id: string;
  result?: unknown;
  error?: string;
}

export const MAX_BROKER_LINE_CHARS = 67_108_864;

export function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
