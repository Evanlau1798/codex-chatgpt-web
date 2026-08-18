import { randomBytes } from "node:crypto";

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
  method: "claim" | "resolve" | "release" | "invoke" | "read_context" | "submit_compaction_handoff";
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
