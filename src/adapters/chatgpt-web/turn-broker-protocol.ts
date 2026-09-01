import { randomBytes } from "node:crypto";
import type { ChatGptTurnEnvironment } from "./environment";

export interface BrokerToolRequest {
  callId: string;
  wireName: string;
  freeform: boolean;
  arguments?: Record<string, unknown>;
  input?: string;
}

export interface BrokerToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: unknown;
}

export interface BrokerRequest {
  id: string;
  method: "claim" | "resolve" | "release" | "invoke" | "read_context" | "submit_compaction_handoff"
    | "owner_status" | "owner_register" | "owner_update" | "owner_next" | "owner_complete"
    | "owner_completion_fence_begin" | "owner_completion_fence_commit" | "owner_revoke" | "activity_complete";
  token?: string;
  bindingId?: string;
  wireName?: string;
  freeform?: boolean;
  arguments?: Record<string, unknown>;
  input?: string;
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
