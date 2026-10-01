import { createHash, randomUUID } from "node:crypto";
import type { CDPSession, Page, Request } from "playwright-core";

/**
 * ChatGPT's response metadata is not part of the Responses model contract. It is a
 * provider-private observation used only for diagnostics and Activity. In particular,
 * `resolved_model_slug` is the only field that can establish what answered a turn.
 */
export const CHATGPT_MODEL_RECEIPT_VERSION = 1 as const;
export const CHATGPT_MODEL_RECEIPT_MAX_BYTES = 2_000_000;
export const CHATGPT_MODEL_RECEIPT_MAX_EVENTS = 256;
export const CHATGPT_MODEL_RECEIPT_MAX_NODES = 4_096;
export const CHATGPT_MODEL_RECEIPT_MAX_FIELD_CHARS = 160;
export const CHATGPT_MODEL_RECEIPT_MAX_OWNED_REQUESTS = 32;
export const CHATGPT_MODEL_RECEIPT_MAX_CDP_CAPTURES = 32;
/** Telemetry-only cleanup budget after inference has already settled. */
export const CHATGPT_MODEL_RECEIPT_TERMINAL_DRAIN_MS = 750;
export const CHATGPT_CONVERSATION_URL = "https://chatgpt.com/backend-api/f/conversation";

const MODEL_FIELDS = [
  "default_model_slug",
  "requested_model_slug",
  "model_slug",
  "resolved_model_slug",
] as const;

type ModelField = (typeof MODEL_FIELDS)[number];

export interface ChatGptModelMetadata {
  defaultModelSlug?: string;
  requestedModelSlug?: string;
  modelSlug?: string;
  resolvedModelSlug?: string;
  conversationId?: string;
  messageId?: string;
}

export type ChatGptModelObservationStatus = "resolved" | "unavailable" | "conflict" | "malformed" | "bounded";

export interface ChatGptModelObservation {
  status: ChatGptModelObservationStatus;
  metadata: ChatGptModelMetadata;
  evidenceCount: number;
  malformedFields: readonly string[];
  conflictingFields: readonly string[];
}

export interface ChatGptModelReceipt {
  kind: "chatgpt_model_receipt";
  version: typeof CHATGPT_MODEL_RECEIPT_VERSION;
  traceId: string;
  physicalSend: number;
  responseAttempt: number;
  provenance: "initial" | "response_retry" | "multipart_stage" | "surface_recovery";
  /** The public Responses model route requested by the native client. */
  requestedModel: string;
  /** The generic backend context model used internally by the Web adapter, if different. */
  backendContextModel?: string;
  /** The model value placed in the browser's owned conversation POST, when available. */
  browserRequestModel?: string;
  /** The sole authoritative served-model value; never a fallback to model_slug. */
  servedModel: string;
  source: "network.resolved_model_slug";
  defaultModelSlug?: string;
  requestedModelSlug?: string;
  modelSlug?: string;
  conversationIdHash?: string;
  messageIdHash?: string;
}

export type ChatGptModelReceiptCallback = (receipt: ChatGptModelReceipt) => void;

export type ChatGptModelReceiptDiagnosticReason =
  | "cdp_unavailable" | "no_owned_request" | "no_cdp_capture" | "foreign_or_unbound"
  | "stream_failed" | "missing_resolved_model" | "bounded" | "conflicting_metadata"
  | "foreign_conversation" | "surface_rebound" | "terminal_drain_timeout" | "telemetry_error" | "receipt_emitted";
export type ChatGptModelReceiptFailureStage =
  | "playwright_requestfailed" | "response_stream" | "data_received" | "loading_finished" | "loading_failed";
export type ChatGptModelReceiptFailureCode =
  | "request_failed" | "stream_resource_content_rejected" | "collector_or_decoder_failed"
  | "network_loading_failed";

export interface ChatGptModelReceiptDiagnostic {
  kind: "chatgpt_model_receipt_diagnostic";
  version: typeof CHATGPT_MODEL_RECEIPT_VERSION;
  traceId: string;
  physicalSend: number;
  responseAttempt: number;
  provenance: ChatGptModelReceipt["provenance"];
  outcome: "resolved" | "unavailable";
  reason: ChatGptModelReceiptDiagnosticReason;
  ownedRequests: number;
  cdpCaptures: number;
  terminalCaptures: number;
  failureStage?: ChatGptModelReceiptFailureStage;
  failureCode?: ChatGptModelReceiptFailureCode;
  transport?: {
    mimeType: "text/event-stream" | "json" | "other";
    fromServiceWorker: boolean;
    fromDiskCache: boolean;
    fromPrefetchCache: boolean;
    fromEarlyHints: boolean;
    fromMemoryCache: boolean;
  };
}

export type ChatGptModelReceiptDiagnosticCallback = (diagnostic: ChatGptModelReceiptDiagnostic) => void;

const RECEIPT_KEYS = new Set([
  "kind", "version", "traceId", "physicalSend", "responseAttempt", "provenance",
  "requestedModel", "backendContextModel", "browserRequestModel", "servedModel", "source",
  "defaultModelSlug", "requestedModelSlug", "modelSlug", "conversationIdHash", "messageIdHash",
]);
const SAFE_RECEIPT_STRING = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const SAFE_RECEIPT_TRACE = /^[A-Za-z0-9_-]{6,128}$/;
const SAFE_RECEIPT_HASH = /^[a-f0-9]{24}$/;
const RECEIPT_DIAGNOSTIC_REASONS = new Set<ChatGptModelReceiptDiagnosticReason>([
  "cdp_unavailable", "no_owned_request", "no_cdp_capture", "foreign_or_unbound", "stream_failed",
  "missing_resolved_model", "bounded", "conflicting_metadata", "foreign_conversation", "surface_rebound",
  "terminal_drain_timeout", "telemetry_error", "receipt_emitted",
]);
const RECEIPT_FAILURE_STAGES = new Set<ChatGptModelReceiptFailureStage>([
  "playwright_requestfailed", "response_stream", "data_received", "loading_finished", "loading_failed",
]);
const RECEIPT_FAILURE_CODES = new Set<ChatGptModelReceiptFailureCode>([
  "request_failed", "stream_resource_content_rejected", "collector_or_decoder_failed", "network_loading_failed",
]);

/** Validate the narrow helper-wire shape; unknown keys are rejected to prevent payload leakage. */
export function assertChatGptModelReceipt(value: unknown, expectedTraceId?: string): ChatGptModelReceipt {
  if (!recordObject(value)) throw new Error("ChatGPT model receipt is not an object");
  const receipt = value as Record<string, unknown>;
  if ([...Object.keys(receipt)].some(key => !RECEIPT_KEYS.has(key))) throw new Error("ChatGPT model receipt has an unsupported field");
  if (receipt.kind !== "chatgpt_model_receipt" || receipt.version !== CHATGPT_MODEL_RECEIPT_VERSION
    || typeof receipt.traceId !== "string" || !SAFE_RECEIPT_TRACE.test(receipt.traceId)
    || !Number.isSafeInteger(receipt.physicalSend) || Number(receipt.physicalSend) <= 0
    || !Number.isSafeInteger(receipt.responseAttempt) || Number(receipt.responseAttempt) <= 0
    || !["initial", "response_retry", "multipart_stage", "surface_recovery"].includes(String(receipt.provenance))
    || typeof receipt.requestedModel !== "string" || !SAFE_RECEIPT_STRING.test(receipt.requestedModel)
    || typeof receipt.servedModel !== "string" || !SAFE_RECEIPT_STRING.test(receipt.servedModel)
    || receipt.source !== "network.resolved_model_slug") {
    throw new Error("ChatGPT model receipt has invalid required fields");
  }
  if (expectedTraceId !== undefined && receipt.traceId !== expectedTraceId) {
    throw new Error("ChatGPT model receipt trace does not match its helper event");
  }
  for (const key of ["backendContextModel", "browserRequestModel", "defaultModelSlug", "requestedModelSlug", "modelSlug"]) {
    if (receipt[key] !== undefined && (typeof receipt[key] !== "string" || !SAFE_RECEIPT_STRING.test(receipt[key]))) {
      throw new Error(`ChatGPT model receipt field ${key} is invalid`);
    }
  }
  for (const key of ["conversationIdHash", "messageIdHash"]) {
    if (receipt[key] !== undefined && (typeof receipt[key] !== "string" || !SAFE_RECEIPT_HASH.test(receipt[key]))) {
      throw new Error(`ChatGPT model receipt field ${key} is invalid`);
    }
  }
  return receipt as unknown as ChatGptModelReceipt;
}

export function assertChatGptModelReceiptDiagnostic(value: unknown, expectedTraceId?: string): ChatGptModelReceiptDiagnostic {
  if (!recordObject(value)) throw new Error("ChatGPT model receipt diagnostic is not an object");
  const diagnostic = value as Record<string, unknown>;
  const allowed = new Set([
    "kind", "version", "traceId", "physicalSend", "responseAttempt", "provenance", "outcome", "reason",
    "ownedRequests", "cdpCaptures", "terminalCaptures", "failureStage", "failureCode", "transport",
  ]);
  if ([...Object.keys(diagnostic)].some(key => !allowed.has(key))) throw new Error("ChatGPT model receipt diagnostic has an unsupported field");
  if (diagnostic.kind !== "chatgpt_model_receipt_diagnostic" || diagnostic.version !== CHATGPT_MODEL_RECEIPT_VERSION
    || typeof diagnostic.traceId !== "string" || !SAFE_RECEIPT_TRACE.test(diagnostic.traceId)
    || !Number.isSafeInteger(diagnostic.physicalSend) || Number(diagnostic.physicalSend) <= 0
    || !Number.isSafeInteger(diagnostic.responseAttempt) || Number(diagnostic.responseAttempt) <= 0
    || !["initial", "response_retry", "multipart_stage", "surface_recovery"].includes(String(diagnostic.provenance))
    || diagnostic.outcome !== "resolved" && diagnostic.outcome !== "unavailable"
    || typeof diagnostic.reason !== "string" || !RECEIPT_DIAGNOSTIC_REASONS.has(diagnostic.reason as ChatGptModelReceiptDiagnosticReason)
    || !Number.isSafeInteger(diagnostic.ownedRequests) || Number(diagnostic.ownedRequests) < 0
    || !Number.isSafeInteger(diagnostic.cdpCaptures) || Number(diagnostic.cdpCaptures) < 0
    || !Number.isSafeInteger(diagnostic.terminalCaptures) || Number(diagnostic.terminalCaptures) < 0
    || Number(diagnostic.ownedRequests) > CHATGPT_MODEL_RECEIPT_MAX_OWNED_REQUESTS
    || Number(diagnostic.cdpCaptures) > CHATGPT_MODEL_RECEIPT_MAX_CDP_CAPTURES
    || Number(diagnostic.terminalCaptures) > CHATGPT_MODEL_RECEIPT_MAX_CDP_CAPTURES) {
    throw new Error("ChatGPT model receipt diagnostic has invalid fields");
  }
  if (expectedTraceId !== undefined && diagnostic.traceId !== expectedTraceId) {
    throw new Error("ChatGPT model receipt diagnostic trace does not match its helper event");
  }
  if (diagnostic.failureStage !== undefined && !RECEIPT_FAILURE_STAGES.has(diagnostic.failureStage as ChatGptModelReceiptFailureStage)) {
    throw new Error("ChatGPT model receipt diagnostic failure stage is invalid");
  }
  if (diagnostic.failureCode !== undefined && !RECEIPT_FAILURE_CODES.has(diagnostic.failureCode as ChatGptModelReceiptFailureCode)) {
    throw new Error("ChatGPT model receipt diagnostic failure code is invalid");
  }
  if (diagnostic.transport !== undefined) {
    const transport = recordObject(diagnostic.transport);
    const keys = ["mimeType", "fromServiceWorker", "fromDiskCache", "fromPrefetchCache", "fromEarlyHints", "fromMemoryCache"];
    if (!transport || Object.keys(transport).some(key => !keys.includes(key))
      || !["text/event-stream", "json", "other"].includes(String(transport.mimeType))
      || keys.slice(1).some(key => typeof transport[key] !== "boolean")) {
      throw new Error("ChatGPT model receipt diagnostic transport is invalid");
    }
  }
  return diagnostic as unknown as ChatGptModelReceiptDiagnostic;
}

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedPrimitive(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > CHATGPT_MODEL_RECEIPT_MAX_FIELD_CHARS) return undefined;
  // Slugs and IDs are intentionally narrower than arbitrary response text. This also
  // prevents a user/assistant prose field from becoming a diagnostic value by accident.
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) return undefined;
  return value;
}

function boundedIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > CHATGPT_MODEL_RECEIPT_MAX_FIELD_CHARS) return undefined;
  if (!/^[A-Za-z0-9][-A-Za-z0-9._:]*$/.test(value)) return undefined;
  return value;
}

function fieldNameToProperty(field: ModelField): keyof ChatGptModelMetadata {
  switch (field) {
    case "default_model_slug": return "defaultModelSlug";
    case "requested_model_slug": return "requestedModelSlug";
    case "model_slug": return "modelSlug";
    case "resolved_model_slug": return "resolvedModelSlug";
  }
}

function digestIdentifier(value: string | undefined): string | undefined {
  return value === undefined
    ? undefined
    : createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}

/**
 * A bounded, clean-room parser for known ChatGPT network metadata. It deliberately does not
 * walk arbitrary response content: only recognized assistant-message, delta, and
 * `server_ste_metadata` structures can contribute fields.
 */
export class ChatGptModelReceiptCollector {
  private readonly values = new Map<ModelField, Set<string>>();
  private readonly malformed = new Set<string>();
  private readonly conflicts = new Set<string>();
  private readonly conversationIds = new Set<string>();
  private readonly messageIds = new Set<string>();
  private nodes = 0;
  private events = 0;
  private bytes = 0;
  private bounded = false;
  private sseBuffer = "";
  private sseData: string[] = [];
  private readonly sseDecoder = new TextDecoder();
  private readonly jsonDecoder = new TextDecoder();
  private jsonBuffer = "";
  private assistantMessageBound = false;
  private deltaAssistantRole = false;
  private deltaMessageId = false;
  private currentMessageId?: string;
  private messageContextConflict = false;

  markBounded(): void { this.bounded = true; }

  private countNode(): boolean {
    this.nodes += 1;
    if (this.nodes > CHATGPT_MODEL_RECEIPT_MAX_NODES) {
      this.bounded = true;
      return false;
    }
    return true;
  }

  private addField(field: ModelField, value: unknown): void {
    if (typeof value !== "string") {
      this.malformed.add(field);
      return;
    }
    const safe = boundedPrimitive(value);
    if (!safe) {
      this.malformed.add(field);
      return;
    }
    const values = this.values.get(field) ?? new Set<string>();
    values.add(safe);
    this.values.set(field, values);
    if (values.size > 1) this.conflicts.add(field);
  }

  private addIdentifier(target: Set<string>, value: unknown): void {
    const safe = boundedIdentifier(value);
    if (safe) target.add(safe);
  }

  private inspectKnownFields(value: Record<string, unknown>): void {
    for (const field of MODEL_FIELDS) {
      if (field in value) this.addField(field, value[field]);
    }
  }

  private inspectMetadata(value: unknown): void {
    const metadata = recordObject(value);
    if (!metadata || !this.countNode()) return;
    this.inspectKnownFields(metadata);
    // IDs are retained only long enough to hash them in the final receipt.
    if ("conversation_id" in metadata) this.addIdentifier(this.conversationIds, metadata.conversation_id);
    if ("message_id" in metadata) this.addIdentifier(this.messageIds, metadata.message_id);
  }

  private inspectAssistantMessage(value: unknown): void {
    const message = recordObject(value);
    if (!message || !this.countNode()) return;
    const author = recordObject(message.author);
    const role = author?.role ?? message.role;
    if (role !== "assistant") return;
    this.assistantMessageBound = true;
    const messageId = boundedIdentifier(message.id);
    if (messageId && this.currentMessageId !== undefined && this.currentMessageId !== messageId) {
      this.messageContextConflict = true;
    }
    if (messageId) this.currentMessageId = messageId;
    this.inspectKnownFields(message);
    this.inspectMetadata(message.metadata);
    if ("conversation_id" in message) this.addIdentifier(this.conversationIds, message.conversation_id);
    if ("id" in message) this.addIdentifier(this.messageIds, message.id);
  }

  private inspectFullEnvelope(value: Record<string, unknown>): void {
    // Full-message responses may expose a single message, a message list, or a mapping.
    const author = recordObject(value.author);
    const hasMessageStructure = "message" in value || "messages" in value || "mapping" in value
      || author?.role === "assistant" || value.role === "assistant";
    if ("message" in value) this.inspectAssistantMessage(value.message);
    if (Array.isArray(value.messages)) {
      if (value.messages.length > CHATGPT_MODEL_RECEIPT_MAX_EVENTS) this.bounded = true;
      for (const message of value.messages.slice(0, CHATGPT_MODEL_RECEIPT_MAX_EVENTS)) this.inspectAssistantMessage(message);
    }
    const mapping = recordObject(value.mapping);
    if (mapping) {
      const envelopes = Object.values(mapping);
      if (envelopes.length > CHATGPT_MODEL_RECEIPT_MAX_EVENTS) this.bounded = true;
      for (const messageEnvelope of envelopes.slice(0, CHATGPT_MODEL_RECEIPT_MAX_EVENTS)) {
        const envelope = recordObject(messageEnvelope);
        if (envelope?.message !== undefined) this.inspectAssistantMessage(envelope.message);
      }
    }
    if (hasMessageStructure && this.assistantMessageBound) this.inspectMetadata(value.metadata);
    // A message object can itself be the event payload.
    if (author?.role === "assistant" || value.role === "assistant") this.inspectAssistantMessage(value);
    if (hasMessageStructure && this.assistantMessageBound && typeof value.conversation_id === "string") {
      this.addIdentifier(this.conversationIds, value.conversation_id);
    }
    if (hasMessageStructure && this.assistantMessageBound) this.inspectKnownFields(value);
  }

  private inspectStreamMetadata(value: unknown): void {
    const metadata = recordObject(value);
    if (!metadata || !this.countNode()) return;
    this.inspectKnownFields(metadata);
    this.inspectMetadata(metadata.metadata);
    if ("conversation_id" in metadata) this.addIdentifier(this.conversationIds, metadata.conversation_id);
    if ("message_id" in metadata) this.addIdentifier(this.messageIds, metadata.message_id);
  }

  private inspectDelta(value: Record<string, unknown>): boolean {
    if (typeof value.p !== "string" || !value.p.startsWith("/message")) return false;
    if (typeof value.o !== "string" || !new Set(["add", "append", "replace", "remove"]).has(value.o)) return true;
    const path = value.p.split("/").filter(Boolean);
    if (path[0] !== "message") return true;
    if (path[1] === "author" && path[2] === "role" && value.v === "assistant") {
      this.deltaAssistantRole = true;
      return true;
    }
    if (path[1] === "id" && boundedIdentifier(value.v)) {
      this.deltaMessageId = true;
      const messageId = boundedIdentifier(value.v)!;
      if (this.currentMessageId !== undefined && this.currentMessageId !== messageId) this.messageContextConflict = true;
      this.currentMessageId = messageId;
      this.addIdentifier(this.messageIds, messageId);
      return true;
    }
    if (path[1] !== "metadata" || this.messageContextConflict
      || !(this.assistantMessageBound || (this.deltaAssistantRole && this.deltaMessageId))) return true;
    if (path.length === 3 && MODEL_FIELDS.includes(path[2] as ModelField)) {
      this.addField(path[2] as ModelField, value.v);
    } else if (path.length === 2) {
      this.inspectMetadata(value.v);
    }
    return true;
  }

  consumeJson(value: unknown): void {
    if (this.bounded || this.events >= CHATGPT_MODEL_RECEIPT_MAX_EVENTS) {
      this.bounded = true;
      return;
    }
    const object = recordObject(value);
    if (!object) return;
    this.events += 1;
    if (!this.countNode()) return;
    if (this.inspectDelta(object)) return;
    if (object.type === "server_ste_metadata" || "server_ste_metadata" in object) {
      this.inspectStreamMetadata(object.server_ste_metadata ?? object.metadata ?? object);
      return;
    }
    this.inspectFullEnvelope(object);
  }

  /** Parse an SSE body incrementally. Non-data event lines are ignored. */
  consumeSseChunk(chunk: string | Uint8Array, final = false): void {
    if (this.bounded) return;
    this.bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (this.bytes > CHATGPT_MODEL_RECEIPT_MAX_BYTES) {
      this.bounded = true;
      return;
    }
    const text = typeof chunk === "string" ? chunk : this.sseDecoder.decode(chunk, { stream: !final });
    this.sseBuffer += text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const lines = this.sseBuffer.split("\n");
    this.sseBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length === 0) {
        this.flushSseEvent();
      } else if (line.startsWith("data:")) {
        const data = line.slice(5).replace(/^ /, "");
        if (data.length > CHATGPT_MODEL_RECEIPT_MAX_BYTES) this.bounded = true;
        else this.sseData.push(data);
      }
    }
    if (final) {
      if (this.sseBuffer.length > 0) {
        if (this.sseBuffer.startsWith("data:")) this.sseData.push(this.sseBuffer.slice(5).replace(/^ /, ""));
        this.sseBuffer = "";
      }
      const trailing = this.sseDecoder.decode();
      if (trailing) this.sseBuffer += trailing;
      this.flushSseEvent();
    }
  }

  consumeJsonChunk(chunk: string | Uint8Array, final = false): void {
    if (this.bounded) return;
    this.bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (this.bytes > CHATGPT_MODEL_RECEIPT_MAX_BYTES) {
      this.bounded = true;
      return;
    }
    this.jsonBuffer += typeof chunk === "string" ? chunk : this.jsonDecoder.decode(chunk, { stream: !final });
    if (this.jsonBuffer.length > CHATGPT_MODEL_RECEIPT_MAX_BYTES) {
      this.bounded = true;
      return;
    }
    if (final) {
      const trailing = this.jsonDecoder.decode();
      if (trailing) this.jsonBuffer += trailing;
      try { this.consumeJson(JSON.parse(this.jsonBuffer)); } catch { this.bounded = true; }
      this.jsonBuffer = "";
    }
  }

  private flushSseEvent(): void {
    if (this.sseData.length === 0) return;
    const data = this.sseData.join("\n");
    this.sseData = [];
    if (data === "[DONE]" || data.length > CHATGPT_MODEL_RECEIPT_MAX_BYTES) return;
    try { this.consumeJson(JSON.parse(data)); } catch { /* unrelated SSE event */ }
  }

  finish(): ChatGptModelObservation {
    const metadata: ChatGptModelMetadata = {};
    const assign = (field: ModelField) => {
      const values = this.values.get(field);
      if (values?.size === 1 && !this.conflicts.has(field)) metadata[fieldNameToProperty(field)] = values.values().next().value as string;
    };
    for (const field of MODEL_FIELDS) assign(field);
    if (this.conversationIds.size === 1) metadata.conversationId = this.conversationIds.values().next().value;
    if (this.messageIds.size === 1) metadata.messageId = this.messageIds.values().next().value;
    const resolvedValues = this.values.get("resolved_model_slug");
    const hasMalformedResolved = this.malformed.has("resolved_model_slug");
    const status: ChatGptModelObservationStatus = this.bounded
      ? "bounded"
      : this.conflicts.has("resolved_model_slug") || this.conversationIds.size > 1 || this.messageIds.size > 1
        ? "conflict"
        : hasMalformedResolved
          ? "malformed"
          : resolvedValues?.size === 1
            ? "resolved"
            : "unavailable";
    return {
      status,
      metadata,
      evidenceCount: this.events,
      malformedFields: [...this.malformed],
      conflictingFields: [...new Set([
        ...this.conflicts,
        ...(this.conversationIds.size > 1 ? ["conversation_id"] : []),
        ...(this.messageIds.size > 1 ? ["message_id"] : []),
      ])],
    };
  }
}

export interface ChatGptModelReceiptSendContext {
  responseAttempt: number;
  provenance?: ChatGptModelReceipt["provenance"];
  expectedConversationId?: string;
}

interface OwnedRequest {
  request: Request;
  requestModel?: string;
  expectedConversationId?: string;
  requestBodyHash?: string;
  cdp?: CdpCapture;
  pageCapture?: CdpCapture;
}

interface ActiveSend extends ChatGptModelReceiptSendContext {
  physicalSend: number;
  activated: boolean;
  emitted: boolean;
  sealed: boolean;
  requests: OwnedRequest[];
  captures: CdpCapture[];
  drain: Promise<void>;
  resolveDrain: () => void;
  drainResolved: boolean;
  draining: boolean;
  diagnosticEmitted: boolean;
  bounded: boolean;
  pageInvocationIds: Map<string, string | undefined>;
}

interface CdpRequestWillBeSent {
  requestId: string;
  frameId?: string;
  request?: { url?: string; method?: string; postData?: string };
}

interface CdpFrameNavigated { frame?: { id?: string; parentId?: string } }

interface CdpResponseReceived {
  requestId: string;
  response?: {
    status?: number;
    headers?: Record<string, unknown>;
    mimeType?: string;
    fromServiceWorker?: boolean;
    fromDiskCache?: boolean;
    fromPrefetchCache?: boolean;
    fromEarlyHints?: boolean;
    fromMemoryCache?: boolean;
  };
}

interface CdpDataReceived {
  requestId: string;
  data?: string;
}

interface CdpLoadingFinished { requestId: string }
interface CdpLoadingFailed { requestId: string }

interface PageFetchCaptureEvent {
  token?: unknown;
  id?: unknown;
  kind?: unknown;
  status?: unknown;
  contentType?: unknown;
  bodyHash?: unknown;
  data?: unknown;
}

interface CdpCapture {
  requestId: string;
  send: ActiveSend;
  source: "cdp" | "page";
  requestModel?: string;
  expectedConversationId?: string;
  requestBodyHash?: string;
  collector: ChatGptModelReceiptCollector;
  playwright?: OwnedRequest;
  contentType?: "json" | "sse";
  responseSeen: boolean;
  terminal: boolean;
  failed: boolean;
  bounded: boolean;
  seenEncodedBytes: number;
  failureStage?: ChatGptModelReceiptFailureStage;
  failureCode?: ChatGptModelReceiptFailureCode;
  transport?: ChatGptModelReceiptDiagnostic["transport"];
  tail: Promise<void>;
}

function requestModelAndConversation(request: Request): { model?: string; conversationId?: string } {
  try {
    const body = request.postDataJSON();
    const object = recordObject(body);
    return {
      ...(typeof object?.model === "string" ? { model: boundedPrimitive(object.model) } : {}),
      ...(typeof object?.conversation_id === "string" ? { conversationId: boundedIdentifier(object.conversation_id) } : {}),
    };
  } catch {
    return {};
  }
}

function requestContextFromPostData(postData: string | undefined): { model?: string; conversationId?: string } {
  if (!postData || postData.length > CHATGPT_MODEL_RECEIPT_MAX_BYTES) return {};
  try {
    const object = recordObject(JSON.parse(postData));
    return {
      ...(typeof object?.model === "string" ? { model: boundedPrimitive(object.model) } : {}),
      ...(typeof object?.conversation_id === "string" ? { conversationId: boundedIdentifier(object.conversation_id) } : {}),
    };
  } catch {
    return {};
  }
}

function cdpHeader(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
  return typeof value === "string" ? value.toLowerCase() : undefined;
}

function contextsMatch(left: OwnedRequest, right: CdpCapture): boolean {
  return (!left.requestModel || !right.requestModel || left.requestModel === right.requestModel)
    && (!left.expectedConversationId || !right.expectedConversationId
      || left.expectedConversationId === right.expectedConversationId);
}

function base64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding);
}

function noteTelemetryFailure(scope: string, error: unknown): void {
  try {
    console.debug(`[chatgpt-web] model receipt telemetry ${scope} unavailable (${error instanceof Error ? error.name : "unknown"})`);
  } catch {
    // Diagnostics must never become a browser-turn failure.
  }
}

interface PageBindingRegistry {
  installed: boolean;
  active?: { observer: WeakRef<ChatGptModelReceiptObserver>; token: string };
}

const PAGE_BINDING_REGISTRIES = new WeakMap<Page, PageBindingRegistry>();

function requestBodyHash(postData: string | null | undefined): string {
  if (postData === null || postData === undefined) return "missing";
  if (postData.length > CHATGPT_MODEL_RECEIPT_MAX_BYTES) return "oversized";
  return createHash("sha256").update(postData).digest("hex");
}

function requestFingerprint(method: string, url: string, postData: string | null | undefined): string {
  const bodyHash = requestBodyHash(postData);
  return `${method.toUpperCase()}|${url}|${bodyHash}`;
}

function playwrightRequestFingerprint(request: Request): string {
  try {
    return requestFingerprint(request.method(), request.url(), request.postData());
  } catch {
    return requestFingerprint(request.method(), request.url(), undefined);
  }
}

function playwrightRequestBodyHash(request: Request): string {
  try {
    return requestBodyHash(request.postData());
  } catch {
    return requestBodyHash(undefined);
  }
}

/**
 * Uses Chromium's Network.streamResourceContent/dataReceived path instead of Playwright's
 * materializing Response.body(). Only an activated, main-frame conversation POST can bind to a
 * capture. Bytes are fed directly into the bounded collector and are never retained as a raw
 * response. If the target is not a Chromium CDP target, source evidence is unavailable.
 */
export class ChatGptModelReceiptObserver {
  private page?: Page;
  private cdp?: CDPSession;
  private mainFrameId?: string;
  private pageCaptureToken?: string;
  private active?: ActiveSend;
  private nextPhysicalSend = 0;
  private surfaceRecoveryPending = false;
  private readonly sends = new Set<ActiveSend>();
  private readonly captures = new Map<string, CdpCapture>();
  /** Requests observed before the current activation are stale, even if their response arrives later. */
  private readonly preActivationRequestFingerprints = new Set<string>();
  private readonly observedBeforeActivation = new Set<string>();
  private readonly onRequest = (request: Request): void => {
    const active = this.active;
    if (!this.page || request.method() !== "POST"
      || request.url() !== this.conversationUrl
      || request.frame() !== this.page.mainFrame()) return;
    const fingerprint = playwrightRequestFingerprint(request);
    if (!active?.activated) {
      if (fingerprint !== undefined) this.observedBeforeActivation.add(fingerprint);
      return;
    }
    if (fingerprint !== undefined && this.preActivationRequestFingerprints.has(fingerprint)) return;
    if (active.requests.length >= CHATGPT_MODEL_RECEIPT_MAX_OWNED_REQUESTS) {
      active.bounded = true;
      return;
    }
    const requestContext = requestModelAndConversation(request);
    const entry: OwnedRequest = {
      request,
      requestBodyHash: playwrightRequestBodyHash(request),
      ...(requestContext.model ? { requestModel: requestContext.model } : {}),
      ...(requestContext.conversationId ?? active.expectedConversationId
        ? { expectedConversationId: requestContext.conversationId ?? active.expectedConversationId }
        : {}),
    };
    active.requests.push(entry);
    this.bind(active);
  };
  private readonly onRequestFailed = (request: Request): void => {
    for (const capture of this.captures.values()) {
      if (capture.playwright?.request !== request) continue;
      capture.failed = true;
      capture.terminal = true;
      capture.failureStage = "playwright_requestfailed";
      capture.failureCode = "request_failed";
      void this.maybeEmit(capture.send).catch(error => noteTelemetryFailure("requestfailed", error));
    }
  };
  readonly onPageCapture = async (value: unknown): Promise<boolean> => {
    const event = recordObject(value) as PageFetchCaptureEvent | undefined;
    if (!event || event.token !== this.pageCaptureToken || typeof event.kind !== "string" || typeof event.id !== "string") return false;
    const active = this.active;
    if (event.kind === "invoke") {
      if (!active?.activated || active.sealed || active.pageInvocationIds.size >= CHATGPT_MODEL_RECEIPT_MAX_OWNED_REQUESTS) return false;
      if (event.bodyHash !== undefined && (typeof event.bodyHash !== "string"
        || (event.bodyHash !== "oversized" && !/^[a-f0-9]{64}$/.test(event.bodyHash)))) return false;
      active.pageInvocationIds.set(event.id, event.bodyHash as string | undefined);
      return true;
    }
    if (event.kind === "abandon") {
      active?.pageInvocationIds.delete(event.id);
      return false;
    }
    if (event.kind === "start") {
      if (!active?.activated || active.sealed || !active.pageInvocationIds.has(event.id)) {
        if (active && active.activated && active.captures.length >= CHATGPT_MODEL_RECEIPT_MAX_CDP_CAPTURES) active.bounded = true;
        return false;
      }
      const requestBodyHash = active.pageInvocationIds.get(event.id);
      active.pageInvocationIds.delete(event.id);
      // A page nonce is not enough by itself: require the corresponding
      // Playwright main-frame request (and, when available, its bounded body
      // hash) before allowing the observation branch to bind.
      if (active.requests.length === 0
        || (requestBodyHash !== undefined && !active.requests.some(request => request.requestBodyHash === requestBodyHash && !request.pageCapture))
        || active.captures.length >= CHATGPT_MODEL_RECEIPT_MAX_CDP_CAPTURES) {
        if (active && active.activated && active.captures.length >= CHATGPT_MODEL_RECEIPT_MAX_CDP_CAPTURES) active.bounded = true;
        return false;
      }
      const contentType = event.contentType === "text/event-stream" ? "sse"
        : event.contentType === "json" ? "json" : undefined;
      if (!contentType || !Number.isInteger(event.status) || Number(event.status) < 200 || Number(event.status) >= 300) return false;
      const capture: CdpCapture = {
        requestId: `page:${event.id}`,
        send: active,
        source: "page",
        ...(requestBodyHash !== undefined ? { requestBodyHash } : {}),
        collector: new ChatGptModelReceiptCollector(),
        contentType,
        responseSeen: true,
        terminal: false,
        failed: false,
        bounded: false,
        seenEncodedBytes: 0,
        tail: Promise.resolve(),
      };
      active.captures.push(capture);
      this.captures.set(capture.requestId, capture);
      this.bind(active);
      return true;
    }
    const capture = this.captures.get(`page:${event.id}`);
    if (!capture || capture.source !== "page") return false;
    if (event.kind === "chunk" && typeof event.data === "string") {
      const encoded = event.data;
      if (!this.reserveEncodedChunk(capture, encoded)) return false;
      capture.tail = capture.tail.then(() => this.consumeCaptureChunk(capture, encoded)).catch(error => {
        capture.failed = true;
        capture.terminal = true;
        capture.failureStage = "data_received";
        capture.failureCode = "collector_or_decoder_failed";
        noteTelemetryFailure("page-data-chunk", error);
      });
      return true;
    }
    if (event.kind === "end") {
      capture.tail = capture.tail.then(() => {
        if (!capture.failed && capture.contentType === "sse") capture.collector.consumeSseChunk(new Uint8Array(), true);
        else if (!capture.failed && capture.contentType === "json") capture.collector.consumeJsonChunk(new Uint8Array(), true);
        capture.terminal = true;
      }).catch(error => {
        capture.failed = true;
        capture.terminal = true;
        capture.failureStage = "loading_finished";
        capture.failureCode = "collector_or_decoder_failed";
        noteTelemetryFailure("page-loading-finished", error);
      });
      void capture.tail.then(() => this.maybeEmit(capture.send), error => noteTelemetryFailure("page-loading-tail", error));
      return true;
    }
    if (event.kind === "bounded") {
      capture.bounded = true;
      capture.collector.markBounded();
      capture.terminal = true;
      void this.maybeEmit(capture.send).catch(error => noteTelemetryFailure("page-bounded", error));
      return false;
    }
    if (event.kind === "failed") {
      capture.failed = true;
      capture.terminal = true;
      capture.failureStage = "data_received";
      capture.failureCode = "collector_or_decoder_failed";
      void this.maybeEmit(capture.send).catch(error => noteTelemetryFailure("page-failed", error));
      return false;
    }
    return false;
  };
  private readonly onCdpFrameNavigated = (payload: CdpFrameNavigated): void => {
    if (payload.frame?.parentId === undefined && payload.frame?.id) this.mainFrameId = payload.frame.id;
  };
  private readonly onCdpRequest = (payload: CdpRequestWillBeSent): void => {
    const active = this.active;
    const request = payload.request;
    if (!active?.activated || !request || request.method !== "POST"
      || request.url !== this.conversationUrl
      || payload.frameId === undefined || payload.frameId !== this.mainFrameId
    ) return;
    const fingerprint = requestFingerprint(request.method, request.url, request.postData);
    if (fingerprint !== undefined && this.preActivationRequestFingerprints.has(fingerprint)) return;
    if (active.captures.length >= CHATGPT_MODEL_RECEIPT_MAX_CDP_CAPTURES) {
      active.bounded = true;
      return;
    }
    const context = requestContextFromPostData(request.postData);
    const capture: CdpCapture = {
      requestId: payload.requestId,
      send: active,
      source: "cdp",
      requestBodyHash: requestBodyHash(request.postData),
      ...(context.model ? { requestModel: context.model } : {}),
      ...(context.conversationId ?? active.expectedConversationId
        ? { expectedConversationId: context.conversationId ?? active.expectedConversationId }
        : {}),
      collector: new ChatGptModelReceiptCollector(),
      responseSeen: false,
      terminal: false,
      failed: false,
      bounded: false,
      seenEncodedBytes: 0,
      tail: Promise.resolve(),
    };
    active.captures.push(capture);
    this.captures.set(capture.requestId, capture);
    this.bind(active);
  };
  private readonly onCdpResponse = (payload: CdpResponseReceived): void => {
    const capture = this.captures.get(payload.requestId);
    if (!capture) return;
    capture.responseSeen = true;
    const status = payload.response?.status ?? 0;
    const contentType = cdpHeader(payload.response?.headers, "content-type") ?? "";
    const mimeType = contentType.includes("text/event-stream") ? "text/event-stream"
      : contentType.includes("json") ? "json" : "other";
    capture.transport = {
      mimeType,
      fromServiceWorker: payload.response?.fromServiceWorker === true,
      fromDiskCache: payload.response?.fromDiskCache === true,
      fromPrefetchCache: payload.response?.fromPrefetchCache === true,
      fromEarlyHints: payload.response?.fromEarlyHints === true,
      fromMemoryCache: payload.response?.fromMemoryCache === true,
    };
    if (status >= 200 && status < 300 && contentType.includes("text/event-stream")) capture.contentType = "sse";
    else if (status >= 200 && status < 300 && contentType.includes("json")) capture.contentType = "json";
    else return;
    capture.tail = capture.tail.then(async () => {
      try {
        const buffered = await this.cdp?.send("Network.streamResourceContent", { requestId: capture.requestId });
        if (buffered?.bufferedData && this.reserveEncodedChunk(capture, buffered.bufferedData)) {
          this.consumeCaptureChunk(capture, buffered.bufferedData);
        }
      } catch {
        capture.failed = true;
        capture.failureStage = "response_stream";
        capture.failureCode = "stream_resource_content_rejected";
      }
    }).catch(error => {
      capture.failed = true;
      capture.terminal = true;
      noteTelemetryFailure("response-stream", error);
    });
    void capture.tail.then(() => this.maybeEmit(capture.send), error => noteTelemetryFailure("response-tail", error));
  };
  private readonly onCdpData = (payload: CdpDataReceived): void => {
    const capture = this.captures.get(payload.requestId);
    if (!capture || capture.failed || !capture.contentType || !payload.data) return;
    if (!this.reserveEncodedChunk(capture, payload.data)) return;
    capture.tail = capture.tail.then(() => this.consumeCaptureChunk(capture, payload.data!))
      .catch(error => {
        capture.failed = true;
        capture.terminal = true;
        capture.failureStage = "data_received";
        capture.failureCode = "collector_or_decoder_failed";
        noteTelemetryFailure("data-chunk", error);
      });
  };
  private readonly onCdpFinished = (payload: CdpLoadingFinished): void => {
    const capture = this.captures.get(payload.requestId);
    if (!capture) return;
    capture.tail = capture.tail.then(() => {
      if (!capture.failed && capture.contentType === "sse") capture.collector.consumeSseChunk(new Uint8Array(), true);
      else if (!capture.failed && capture.contentType === "json") capture.collector.consumeJsonChunk(new Uint8Array(), true);
      capture.terminal = true;
    }).catch(error => {
      capture.failed = true;
      capture.terminal = true;
      capture.failureStage = "loading_finished";
      capture.failureCode = "collector_or_decoder_failed";
      noteTelemetryFailure("loading-finished", error);
    });
    void capture.tail.then(() => this.maybeEmit(capture.send), error => noteTelemetryFailure("loading-tail", error));
  };
  private readonly onCdpFailed = (payload: CdpLoadingFailed): void => {
    const capture = this.captures.get(payload.requestId);
    if (!capture) return;
    capture.failed = true;
    capture.terminal = true;
    capture.failureStage = "loading_failed";
    capture.failureCode = "network_loading_failed";
    void this.maybeEmit(capture.send).catch(error => noteTelemetryFailure("loading-failed", error));
  };

  private consumeCaptureChunk(capture: CdpCapture, encoded: string): void {
    const bytes = Buffer.from(encoded, "base64");
    if (capture.contentType === "sse") capture.collector.consumeSseChunk(bytes);
    else if (capture.contentType === "json") capture.collector.consumeJsonChunk(bytes);
  }

  private reserveEncodedChunk(capture: CdpCapture, encoded: string): boolean {
    if (capture.bounded) return false;
    const incoming = base64ByteLength(encoded);
    if (incoming > CHATGPT_MODEL_RECEIPT_MAX_BYTES - capture.seenEncodedBytes) {
      capture.bounded = true;
      capture.collector.markBounded();
      return false;
    }
    capture.seenEncodedBytes += incoming;
    return true;
  }

  private bind(active: ActiveSend): void {
    for (const request of active.requests) {
      if (!request.cdp) {
        const capture = active.captures.find(candidate => candidate.source === "cdp" && !candidate.playwright
          && (!candidate.requestBodyHash || !request.requestBodyHash || candidate.requestBodyHash === request.requestBodyHash)
          && contextsMatch(request, candidate));
        if (capture) {
          request.cdp = capture;
          capture.playwright = request;
        }
      }
      if (!request.pageCapture) {
        const capture = active.captures.find(candidate => candidate.source === "page" && !candidate.playwright
          && (!candidate.requestBodyHash || !request.requestBodyHash || candidate.requestBodyHash === request.requestBodyHash)
          && contextsMatch(request, candidate));
        if (capture) {
          request.pageCapture = capture;
          capture.playwright = request;
        }
      }
    }
  }

  private resolveDrain(active: ActiveSend): void {
    if (active.drainResolved) return;
    active.drainResolved = true;
    this.sends.delete(active);
    active.resolveDrain();
  }

  private emitDiagnostic(active: ActiveSend, outcome: "resolved" | "unavailable", reason: ChatGptModelReceiptDiagnosticReason, failedCapture?: CdpCapture): void {
    if (!active.activated || active.diagnosticEmitted) return;
    active.diagnosticEmitted = true;
    const diagnostic: ChatGptModelReceiptDiagnostic = {
      kind: "chatgpt_model_receipt_diagnostic",
      version: CHATGPT_MODEL_RECEIPT_VERSION,
      traceId: this.traceId,
      physicalSend: active.physicalSend,
      responseAttempt: active.responseAttempt,
      provenance: active.provenance!,
      outcome,
      reason,
      ownedRequests: active.requests.length,
      cdpCaptures: active.captures.filter(capture => capture.source === "cdp").length,
      terminalCaptures: active.captures.filter(capture => capture.terminal).length,
      ...(failedCapture?.failureStage ? { failureStage: failedCapture.failureStage } : {}),
      ...(failedCapture?.failureCode ? { failureCode: failedCapture.failureCode } : {}),
      ...(failedCapture?.transport ? { transport: failedCapture.transport } : {}),
    };
    try { this.onDiagnostic?.(diagnostic); } catch (error) { noteTelemetryFailure("diagnostic-callback", error); }
  }

  private discardSend(active: ActiveSend, reason?: ChatGptModelReceiptDiagnosticReason, failedCapture?: CdpCapture): void {
    if (reason) this.emitDiagnostic(active, "unavailable", reason, failedCapture);
    active.emitted = true;
    for (const capture of active.captures) {
      if (this.captures.get(capture.requestId) === capture) this.captures.delete(capture.requestId);
    }
    active.captures = [];
    active.requests = [];
    active.pageInvocationIds.clear();
    this.resolveDrain(active);
  }

  private async maybeEmit(active: ActiveSend): Promise<void> {
    try {
      await this.maybeEmitUnsafe(active);
    } catch (error) {
      noteTelemetryFailure("settlement", error);
      try { this.discardSend(active, "telemetry_error"); } catch (discardError) { noteTelemetryFailure("cleanup", discardError); }
    }
  }

  private async maybeEmitUnsafe(active: ActiveSend): Promise<void> {
    if (!active.sealed || active.emitted || active.draining) return;
    if (active.bounded) {
      this.discardSend(active, "bounded");
      return;
    }
    if (active.captures.length === 0) {
      this.emitDiagnostic(active, "unavailable", this.cdp
        ? active.requests.length > 0 ? "no_cdp_capture" : "no_owned_request"
        : "cdp_unavailable");
      this.resolveDrain(active);
      return;
    }
    if (active.requests.some(request => !request.cdp && !request.pageCapture) || active.captures.some(capture => !capture.terminal)) return;
    active.draining = true;
    await Promise.all(active.captures.map(capture => capture.tail));
    if (active.emitted) {
      active.draining = false;
      return;
    }
    active.emitted = true;
    const observations = active.captures.map(capture => ({
      capture,
      observation: capture.collector.finish(),
    }));
    const resolvedPageObservations = observations.filter(({ capture, observation }) => capture.source === "page" && !capture.failed && capture.playwright && observation.status === "resolved");
    const resolvedCdpObservations = observations.filter(({ capture, observation }) => capture.source === "cdp" && !capture.failed && capture.playwright && observation.status === "resolved");
    const boundPageObservations = observations.filter(({ capture }) => capture.source === "page" && !capture.failed && capture.playwright);
    const boundCdpObservations = observations.filter(({ capture }) => capture.source === "cdp" && !capture.failed && capture.playwright && capture.contentType);
    if ((resolvedPageObservations.length > 0 && boundPageObservations.some(({ observation }) => observation.status !== "resolved"))
      || (resolvedCdpObservations.length > 0 && boundCdpObservations.some(({ observation }) => observation.status !== "resolved"))
      || (resolvedPageObservations.length > 0 && boundCdpObservations.length > 0 && resolvedCdpObservations.length === 0)
      || (resolvedCdpObservations.length > 0 && boundPageObservations.length > 0 && resolvedPageObservations.length === 0)) {
      this.discardSend(active, "conflicting_metadata");
      return;
    }
    if (resolvedPageObservations.length > 0 && resolvedCdpObservations.length > 0) {
      const evidence = (observation: ChatGptModelObservation): string => JSON.stringify({
        served: observation.metadata.resolvedModelSlug,
        message: observation.metadata.messageId,
        conversation: observation.metadata.conversationId,
      });
      const pageEvidence = evidence(resolvedPageObservations[0]!.observation);
      if (resolvedCdpObservations.some(({ observation }) => evidence(observation) !== pageEvidence)) {
        this.discardSend(active, "conflicting_metadata");
        return;
      }
    }
    const selectedObservations = resolvedPageObservations.length > 0 ? resolvedPageObservations : resolvedCdpObservations;
    if (selectedObservations.length === 0 || selectedObservations.some(({ capture, observation }) => (
      capture.failed || !capture.playwright || observation.status !== "resolved"
      || (capture.expectedConversationId !== undefined
        && observation.metadata.conversationId !== undefined
        && capture.expectedConversationId !== observation.metadata.conversationId)
    ))) {
      const failedCapture = active.captures.find(capture => capture.failed);
      const reason: ChatGptModelReceiptDiagnosticReason = failedCapture
        ? "stream_failed"
        : active.captures.some(capture => !capture.playwright)
          ? "foreign_or_unbound"
          : active.captures.some(capture => capture.collector.finish().status === "bounded")
            ? "bounded"
            : active.captures.some(capture => capture.expectedConversationId !== undefined
              && capture.collector.finish().metadata.conversationId !== undefined
              && capture.expectedConversationId !== capture.collector.finish().metadata.conversationId)
              ? "foreign_conversation"
              : "missing_resolved_model";
      this.discardSend(active, reason, failedCapture);
      return;
    }
    const resolvedObservations = selectedObservations.map(({ observation }) => observation);
    const served = new Set(resolvedObservations.map(observation => observation.metadata.resolvedModelSlug).filter((value): value is string => value !== undefined));
    const messages = new Set(resolvedObservations.map(observation => observation.metadata.messageId).filter((value): value is string => value !== undefined));
    if (served.size !== 1 || messages.size > 1) {
      this.discardSend(active, "conflicting_metadata");
      return;
    }
    const observation = resolvedObservations[0]!;
    const requestModels = new Set(active.requests.map(entry => entry.requestModel).filter((value): value is string => value !== undefined));
    const receipt: ChatGptModelReceipt = {
      kind: "chatgpt_model_receipt",
      version: CHATGPT_MODEL_RECEIPT_VERSION,
      traceId: this.traceId,
      physicalSend: active.physicalSend,
      responseAttempt: active.responseAttempt,
      provenance: active.provenance!,
      requestedModel: this.requestedModel,
      ...(this.backendContextModel && this.backendContextModel !== this.requestedModel ? { backendContextModel: this.backendContextModel } : {}),
      ...(requestModels.size === 1 ? { browserRequestModel: [...requestModels][0] } : {}),
      servedModel: [...served][0]!,
      source: "network.resolved_model_slug",
      ...(observation.metadata.defaultModelSlug ? { defaultModelSlug: observation.metadata.defaultModelSlug } : {}),
      ...(observation.metadata.requestedModelSlug ? { requestedModelSlug: observation.metadata.requestedModelSlug } : {}),
      ...(observation.metadata.modelSlug ? { modelSlug: observation.metadata.modelSlug } : {}),
      ...(observation.metadata.conversationId ? { conversationIdHash: digestIdentifier(observation.metadata.conversationId) } : {}),
      ...(observation.metadata.messageId ? { messageIdHash: digestIdentifier(observation.metadata.messageId) } : {}),
    };
    try { this.onReceipt?.(receipt); } catch { /* diagnostics are never turn-critical */ }
    // Preserve a bounded transport failure alongside a successful page-local
    // fallback so live diagnostics explain why CDP evidence was unavailable;
    // the failure never becomes a turn error or a model fallback.
    this.emitDiagnostic(active, "resolved", "receipt_emitted", active.captures.find(capture => capture.failed));
    this.discardSend(active);
  };

  private async installPageCapture(page: Page): Promise<void> {
    if (typeof page.exposeBinding !== "function") return;
    const token = randomUUID();
    let registry = PAGE_BINDING_REGISTRIES.get(page);
    if (!registry) {
      registry = { installed: false };
      PAGE_BINDING_REGISTRIES.set(page, registry);
    }
    try {
      if (!registry.installed) {
        await page.exposeBinding("__codexModelReceiptDispatch", (source, event) => {
          const sourceRecord = recordObject(source);
          if (!sourceRecord || sourceRecord.frame !== page.mainFrame()) return false;
          const eventRecord = recordObject(event);
          if (!eventRecord || Object.keys(eventRecord).some(key => !["token", "id", "kind", "status", "contentType", "bodyHash", "data"].includes(key))) return false;
          const active = registry!.active;
          const observer = active?.observer.deref();
          if (!active || !observer || active.token !== eventRecord.token) return false;
          return observer.onPageCapture(event);
        });
        registry.installed = true;
      }
      // A Page can be rebound to a new observer without the old observer being
      // disposed first.  Remove the old wrapper before publishing the new token;
      // the page-side uninstall is identity-checked and therefore cannot clobber
      // a fetch wrapper installed by application code after ours.
      await page.evaluate(() => {
        const root = globalThis as typeof globalThis & { __codexModelReceiptCaptureState?: { uninstall?: () => void } };
        root.__codexModelReceiptCaptureState?.uninstall?.();
      });
      registry.active = { observer: new WeakRef(this), token };
      await page.evaluate(({ url, token, maxBytes }) => {
        const root = globalThis as typeof globalThis & {
          __codexModelReceiptDispatch?: (event: unknown) => Promise<boolean>;
          __codexModelReceiptCaptureState?: { wrapper: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>; uninstall: () => void };
        };
        const originalFetch = window.fetch;
        let sequence = 0;
        const encode = (value: Uint8Array): string => {
          let binary = "";
          for (let index = 0; index < value.length; index += 0x8000) {
            binary += String.fromCharCode(...value.subarray(index, Math.min(value.length, index + 0x8000)));
          }
          return btoa(binary);
        };
        const requestBodyHash = (body: BodyInit | null | undefined): Promise<string | undefined> => {
          if (typeof body !== "string") return Promise.resolve(undefined);
          if (body.length > maxBytes) return Promise.resolve("oversized");
          if (!globalThis.crypto?.subtle) return Promise.resolve(undefined);
          return globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)).then(value => {
            const bytes = new Uint8Array(value);
            return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
          }, () => undefined);
        };
        const binding = root.__codexModelReceiptDispatch;
        const wrapped = async function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
          const requestUrl = typeof input === "string"
            ? new URL(input, location.href).href
            : input instanceof Request ? input.url : String(input);
          const requestMethod = (init?.method ?? (typeof input !== "string" && input instanceof Request ? input.method : "GET")).toUpperCase();
          const eligibleInvocation = requestUrl === url && requestMethod === "POST" && Boolean(binding);
          const id = eligibleInvocation ? `${token}_${++sequence}` : undefined;
          // Announce invocation before the network response. The detached
          // binding never gates the original fetch; it only gives Node a nonce
          // and bounded request-body identity for later ownership matching.
          const invocation = eligibleInvocation
            ? requestBodyHash(init?.body).then(bodyHash => binding!({
              token,
              id,
              kind: "invoke",
              ...(bodyHash !== undefined ? { bodyHash } : {}),
            }))
              .then(value => value === true, () => false)
            : Promise.resolve(false);
          const abandonInvocation = (): void => {
            if (id === undefined || !binding) return;
            void invocation.then(accepted => {
              if (accepted) void binding({ token, id, kind: "abandon" }).catch(() => {});
            });
          };
          let response: Response;
          try {
            response = await originalFetch.call(window, input, init);
          } catch (error) {
            abandonInvocation();
            throw error;
          }
          if (!eligibleInvocation || response.url !== url || id === undefined || !binding) {
            abandonInvocation();
            return response;
          }
          const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
          const mediaType = contentType.includes("text/event-stream") ? "text/event-stream"
            : contentType.includes("json") ? "json" : "other";
          let accepted = false;
          let decisionDone = false;
          let boundedReported = false;
          let failedReported = false;
          const decision = invocation.then(invoked => invoked
            ? binding({ token, id, kind: "start", status: response.status, contentType: mediaType })
              .then(value => value === true, () => false)
            : false, () => false)
            .then(value => { accepted = value; decisionDone = true; }, () => { accepted = false; decisionDone = true; });
          const reportBounded = (): void => {
            if (boundedReported) return;
            boundedReported = true;
            void binding({ token, id, kind: "bounded" }).catch(() => {});
          };
          const reportFailed = (): void => {
            if (failedReported) return;
            failedReported = true;
            void binding({ token, id, kind: "failed" }).catch(() => {});
          };
          const reportFailedAfterDecision = (): void => {
            if (decisionDone && accepted) reportFailed();
            else if (!decisionDone) void decision.then(() => { if (accepted) reportFailed(); });
          };
          void (async () => {
            const pending: Array<{ data: string; decodedBytes: number; encodedBytes: number }> = [];
            let pendingDecodedBytes = 0;
            let pendingEncodedBytes = 0;
            let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
            const flushPending = async (): Promise<void> => {
              if (!accepted) return;
              for (const item of pending.splice(0)) await binding({ token, id, kind: "chunk", data: item.data });
              pendingDecodedBytes = 0;
              pendingEncodedBytes = 0;
            };
            try {
              reader = response.clone().body?.getReader();
              if (!reader) { reportFailedAfterDecision(); return; }
              let seen = 0;
              for (;;) {
                const next = await reader.read();
                if (next.done) break;
                const bytes = next.value?.byteLength ?? 0;
                if (seen + bytes > maxBytes || pendingDecodedBytes + bytes > maxBytes) {
                  await reader.cancel();
                  if (decisionDone && accepted) reportBounded();
                  else if (!decisionDone) void decision.then(() => { if (accepted) reportBounded(); });
                  return;
                }
                seen += bytes;
                if (!next.value?.byteLength) continue;
                const data = encode(next.value);
                if (!decisionDone) {
                  if (pendingEncodedBytes + data.length > maxBytes) {
                    await reader.cancel();
                    if (decisionDone && accepted) reportBounded();
                    else if (!decisionDone) void decision.then(() => { if (accepted) reportBounded(); });
                    return;
                  }
                  pending.push({ data, decodedBytes: bytes, encodedBytes: data.length });
                  pendingDecodedBytes += bytes;
                  pendingEncodedBytes += data.length;
                  continue;
                }
                if (!accepted) { await reader.cancel(); return; }
                await flushPending();
                await binding({ token, id, kind: "chunk", data });
              }
              await decision;
              if (!accepted) { await reader.cancel(); return; }
              await flushPending();
              await binding({ token, id, kind: "end" });
            } catch {
              // The reader belongs only to the observation clone.  Always
              // cancel it after a binding/reader failure so a stalled or
              // rejected telemetry path cannot retain the tee backlog or
              // cancel the original fetch branch.
              await reader?.cancel().catch(() => {});
              reportFailedAfterDecision();
            }
          })();
          return response;
        };
        Object.assign(wrapped, originalFetch);
        window.fetch = wrapped as typeof window.fetch;
        root.__codexModelReceiptCaptureState = {
          wrapper: wrapped,
          uninstall: () => {
            if (window.fetch === wrapped) window.fetch = originalFetch;
            if (root.__codexModelReceiptCaptureState?.wrapper === wrapped) delete root.__codexModelReceiptCaptureState;
          },
        };
      }, { url: this.conversationUrl, token, maxBytes: CHATGPT_MODEL_RECEIPT_MAX_BYTES });
      this.pageCaptureToken = token;
    } catch (error) {
      registry.active = undefined;
      noteTelemetryFailure("page-capture-install", error);
    }
  }

  constructor(
    private readonly traceId: string,
    private readonly requestedModel: string,
    private readonly backendContextModel: string | undefined,
  private readonly onReceipt?: ChatGptModelReceiptCallback,
  private readonly conversationUrl = CHATGPT_CONVERSATION_URL,
  private readonly onDiagnostic?: ChatGptModelReceiptDiagnosticCallback,
) {}

  async attach(page: Page): Promise<void> {
    if (this.page === page) return;
    if (this.page) {
      const previous = this.active;
      await this.flushCurrent();
      if (previous?.activated && previous.sealed && !previous.emitted) {
        this.surfaceRecoveryPending = true;
        this.discardSend(previous, "surface_rebound");
      }
      await this.detach();
    }
    const candidate = page as Page & {
      on?: (event: string, listener: (value: unknown) => void) => void;
      context?: () => { newCDPSession?: (target: Page) => Promise<CDPSession> };
    };
    if (typeof candidate.on !== "function" || typeof candidate.context !== "function"
      || typeof candidate.context()?.newCDPSession !== "function") return;
    let session: CDPSession | undefined;
    try {
      session = await candidate.context()!.newCDPSession!(page);
      this.cdp = session;
      session.on("Page.frameNavigated", this.onCdpFrameNavigated);
      session.on("Network.requestWillBeSent", this.onCdpRequest);
      session.on("Network.responseReceived", this.onCdpResponse);
      session.on("Network.dataReceived", this.onCdpData);
      session.on("Network.loadingFinished", this.onCdpFinished);
      session.on("Network.loadingFailed", this.onCdpFailed);
      await session.send("Network.enable");
      const frameTree = await session.send("Page.getFrameTree");
      this.mainFrameId = frameTree.frameTree.frame.id;
    } catch (error) {
      noteTelemetryFailure("attach", error);
      if (session) {
        session.off("Page.frameNavigated", this.onCdpFrameNavigated);
        session.off("Network.requestWillBeSent", this.onCdpRequest);
        session.off("Network.responseReceived", this.onCdpResponse);
        session.off("Network.dataReceived", this.onCdpData);
        session.off("Network.loadingFinished", this.onCdpFinished);
        session.off("Network.loadingFailed", this.onCdpFailed);
        await session.detach().catch(detachError => noteTelemetryFailure("attach-cleanup", detachError));
      }
      if (this.cdp === session) this.cdp = undefined;
      this.mainFrameId = undefined;
      return;
    }
    this.page = page;
    candidate.on("request", this.onRequest);
    candidate.on("requestfailed", this.onRequestFailed);
    await this.installPageCapture(page);
  }

  beginSend(context: ChatGptModelReceiptSendContext): void {
    if (this.active && !this.active.emitted && !this.active.sealed) {
      this.active.sealed = true;
      void this.maybeEmit(this.active);
    }
    const provenance = this.surfaceRecoveryPending
      ? "surface_recovery"
      : context.provenance ?? (context.responseAttempt > 1 ? "response_retry" : "initial");
    this.surfaceRecoveryPending = false;
    for (const fingerprint of this.observedBeforeActivation) this.preActivationRequestFingerprints.add(fingerprint);
    this.observedBeforeActivation.clear();
    if (this.preActivationRequestFingerprints.size > CHATGPT_MODEL_RECEIPT_MAX_OWNED_REQUESTS * 2) {
      const oldest = this.preActivationRequestFingerprints.values().next().value as string | undefined;
      if (oldest !== undefined) this.preActivationRequestFingerprints.delete(oldest);
    }
    let resolveDrain!: () => void;
    const drain = new Promise<void>(resolve => { resolveDrain = resolve; });
    this.active = {
      ...context,
      provenance,
      physicalSend: ++this.nextPhysicalSend,
      activated: false,
      emitted: false,
      sealed: false,
      requests: [],
      captures: [],
      drain,
      resolveDrain,
      drainResolved: false,
      draining: false,
      diagnosticEmitted: false,
      bounded: false,
      pageInvocationIds: new Map(),
    };
    this.sends.add(this.active);
  }

  activate(): void {
    if (!this.active) throw new Error("ChatGPT model receipt observer has no active Send");
    for (const fingerprint of this.observedBeforeActivation) this.preActivationRequestFingerprints.add(fingerprint);
    this.observedBeforeActivation.clear();
    this.active.activated = true;
  }

  async flushCurrent(): Promise<void> {
    const active = this.active;
    if (!active || active.emitted) return;
    try {
      active.sealed = true;
      await Promise.all(active.captures.map(capture => capture.tail));
      await this.maybeEmit(active);
    } catch (error) {
      noteTelemetryFailure("flush", error);
      try { this.discardSend(active, "telemetry_error"); } catch (discardError) { noteTelemetryFailure("flush-cleanup", discardError); }
    }
  }

  async flushAll(): Promise<void> { await this.flushCurrent(); }

  async dispose(): Promise<void> {
    try {
      await this.flushCurrent();
      const drains = [...this.sends].map(send => send.drain);
      if (drains.length > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.all(drains),
          new Promise<void>(resolve => { timer = setTimeout(resolve, CHATGPT_MODEL_RECEIPT_TERMINAL_DRAIN_MS); }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
      }
    } catch (error) {
      noteTelemetryFailure("dispose", error);
    } finally {
      try {
        for (const send of [...this.sends]) this.discardSend(send, "terminal_drain_timeout");
        await this.detach();
        this.captures.clear();
        this.sends.clear();
        this.active = undefined;
      } catch (cleanupError) {
        noteTelemetryFailure("dispose-cleanup", cleanupError);
      }
    }
  }

  async detach(): Promise<void> {
    const boundPage = this.page;
    const candidate = this.page as (Page & {
      off?: (event: string, listener: (value: unknown) => void) => void;
    }) | undefined;
    try {
      if (candidate?.off) {
        candidate.off("request", this.onRequest);
        candidate.off("requestfailed", this.onRequestFailed);
      }
    } catch (error) {
      noteTelemetryFailure("detach-page-listeners", error);
    }
    try {
      if (this.cdp) {
        this.cdp.off("Page.frameNavigated", this.onCdpFrameNavigated);
        this.cdp.off("Network.requestWillBeSent", this.onCdpRequest);
        this.cdp.off("Network.responseReceived", this.onCdpResponse);
        this.cdp.off("Network.dataReceived", this.onCdpData);
        this.cdp.off("Network.loadingFinished", this.onCdpFinished);
        this.cdp.off("Network.loadingFailed", this.onCdpFailed);
        await this.cdp.detach().catch(error => noteTelemetryFailure("detach", error));
      }
    } catch (error) {
      noteTelemetryFailure("detach-cdp", error);
    }
    try {
      if (this.page && this.pageCaptureToken) {
        await this.page.evaluate(() => {
          const root = globalThis as typeof globalThis & { __codexModelReceiptCaptureState?: { uninstall?: () => void } };
          root.__codexModelReceiptCaptureState?.uninstall?.();
        }).catch(error => noteTelemetryFailure("page-capture-uninstall", error));
      }
    } catch (error) {
      noteTelemetryFailure("detach-page-capture", error);
    } finally {
      const registry = boundPage ? PAGE_BINDING_REGISTRIES.get(boundPage) : undefined;
      if (registry?.active?.observer.deref() === this) registry.active = undefined;
      this.page = undefined;
      this.cdp = undefined;
      this.mainFrameId = undefined;
      this.pageCaptureToken = undefined;
    }
  }

}

export function hashChatGptReceiptIdentifier(value: string): string {
  return digestIdentifier(value)!;
}
