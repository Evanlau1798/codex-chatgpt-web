import { parseDataUrl } from "../image";
import { isUsableCompactionSummary } from "../../responses/compaction";
import type { CodexContentPart, CodexParsedRequest, CodexToolResultMessage } from "../../types";
import { extractChatGptCompactionSourceRevision } from "./environment";
import type { BrokerToolResult, TurnBroker } from "./turn-broker";
import type { ChatGptTurnSession } from "./turn-execution";
import { activeCompactionToolResultInstruction } from "./native-compaction-control";

export const LATEST_USER_PROMPT_MARKER = "CODEX_LATEST_USER_PROMPT_JSON";
export const MAX_COMPACTION_HANDOFF_TIMEOUT_MS = 5 * 60_000;

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    const parsed = parseDataUrl(part.imageUrl);
    if (parsed) return { type: "image", data: parsed.base64, mimeType: parsed.mediaType };
    return { type: "resource_link", uri: part.imageUrl, name: "Codex tool image", mimeType: "image/*" };
  });
}

function structuredContent(text: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}
export function codexToolResultToBrokerResult(message: CodexToolResultMessage): BrokerToolResult {
  const content = brokerContent(message.content);
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const structured = structuredContent(text);
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    ...(message.isError ? { isError: true } : {}),
  };
}

function interruptedByActiveCompaction(): BrokerToolResult {
  return {
    content: [{
      type: "text",
      text: activeCompactionToolResultInstruction(),
    }],
    isError: true,
  };
}

export function codexToolResultsById(
  parsed: CodexParsedRequest,
  session: ChatGptTurnSession,
): Map<string, CodexToolResultMessage> {
  const byId = new Map<string, CodexToolResultMessage>();
  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult" || !session.hasOutstanding(message.toolCallId)) continue;
    if (byId.has(message.toolCallId)) throw new Error(`Codex returned duplicate results for tool call ${message.toolCallId}`);
    byId.set(message.toolCallId, message);
  }
  return byId;
}

function userPromptText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap(part => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const value = part as { type?: unknown; text?: unknown };
    return (value.type === "input_text" || value.type === "text") && typeof value.text === "string"
      ? [value.text]
      : [];
  }).join("\n");
  return text.length > 0 ? text : undefined;
}

export function canonicalizeCompactionHandoff(parsed: CodexParsedRequest, summary: string): string | undefined {
  if (!isUsableCompactionSummary(summary)) return undefined;
  let latestUserPrompt: string | undefined;
  try {
    latestUserPrompt = userPromptText(extractChatGptCompactionSourceRevision(parsed).content);
  } catch {
    return undefined;
  }
  if (latestUserPrompt === undefined) return undefined;
  const appendix = `${LATEST_USER_PROMPT_MARKER}\n${JSON.stringify(latestUserPrompt)}`;
  const markerOffset = summary.lastIndexOf(`\n${LATEST_USER_PROMPT_MARKER}\n`);
  if (markerOffset >= 0) {
    return summary.slice(markerOffset + 1).trimEnd() === appendix ? summary.trimEnd() : undefined;
  }
  return `${summary.trimEnd()}\n\n${appendix}`;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("ChatGPT compaction handoff aborted", "AbortError");
}

export function withCompactionAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

export async function settleActiveCompactionSource(
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  broker: TurnBroker,
  signal?: AbortSignal,
): Promise<{ answer: string; compactionInstructionDelivered: boolean }> {
  return source.runExclusive(async () => {
    if (signal?.aborted) { source.cancel(abortReason(signal)); throw abortReason(signal); }
    if (!source.isActive() || source.runtime.mode !== "tools") {
      throw new Error("The active ChatGPT compaction source has no MCP tool boundary");
    }
    const outstanding = source.outstanding();
    const results = codexToolResultsById(parsed, source);
    if (results.size !== outstanding.length) {
      throw new Error(`Codex supplied ${results.size} of ${outstanding.length} required tool results for compaction`);
    }
    let token: string | undefined;
    try {
      token = await source.runtime.token;
      broker.requestCompaction(token, interruptedByActiveCompaction());
      for (const request of outstanding) {
        const result = results.get(request.callId)!;
        broker.completeTool(token, request.callId, codexToolResultToBrokerResult(result));
        source.markResultDelivered(request.callId, result);
      }
      const outcome = await withCompactionAbort(source.browserOutcome, signal);
      if (outcome.type === "error") throw outcome.error;
      const compactionInstructionDelivered = broker.compactionDeliveryCount(token) > 0;
      await withCompactionAbort(source.physicalSettlement, signal);
      return { answer: outcome.answer, compactionInstructionDelivered };
    } catch (error) {
      if (signal?.aborted) source.cancel(abortReason(signal));
      throw error;
    } finally {
      if (token) await broker.revoke(token);
    }
  });
}

interface CachedCompactionRun { createdAt: number; promise: Promise<string> }
const structuredCompactionRuns = new Map<string, CachedCompactionRun>();
const STRUCTURED_COMPACTION_RUN_TTL_MS = 30 * 60_000;

function pruneStructuredCompactionRuns(): void {
  const cutoff = Date.now() - STRUCTURED_COMPACTION_RUN_TTL_MS;
  for (const [key, run] of structuredCompactionRuns) {
    if (run.createdAt < cutoff) structuredCompactionRuns.delete(key);
  }
}

export function existingStructuredCompactionRun(key: string): Promise<string> | undefined {
  pruneStructuredCompactionRuns();
  return structuredCompactionRuns.get(key)?.promise;
}

export function runStructuredCompactionOnce(key: string, start: () => Promise<string>): Promise<string> {
  pruneStructuredCompactionRuns();
  const existing = structuredCompactionRuns.get(key);
  if (existing) return existing.promise;
  const promise = Promise.resolve().then(start);
  structuredCompactionRuns.set(key, { createdAt: Date.now(), promise });
  void promise.catch(() => {
    if (structuredCompactionRuns.get(key)?.promise === promise) structuredCompactionRuns.delete(key);
  });
  return promise;
}
