import { createHash } from "node:crypto";
import type { AppConfig } from "./config";
import type { AdapterEvent, CodexMessage, CodexParsedRequest } from "./types";
import { bridgeToResponsesSSE, buildResponseJSON } from "./bridge";
import { codexTurnMetadataFromBody } from "./adapters/chatgpt-web/environment-identity";
import { parseRequest } from "./responses/parser";

export const COMPOSER_PREDICTION_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 256;
const entries = new Map<string, { suggestion: string; expiresAt: number }>();

export function composerPredictionEnabled(config: AppConfig): boolean {
  return config.composerPredictionsEnabled === true && config.mode === "full"
    && config.useEnhancedWebSessionMode === true && config.useEnhancedOutputTunnel !== false
    && config.browserInteractionMode !== "manual";
}

function content(message: CodexMessage): unknown {
  return typeof message.content === "string" ? [{ type: "text", text: message.content }]
    : message.content;
}

function key(namespace: string, threadId: unknown, user: CodexMessage | undefined, answer: string): string | undefined {
  if (typeof threadId !== "string" || !threadId || !user || !answer) return undefined;
  return createHash("sha256").update(JSON.stringify([namespace, threadId, content(user), answer])).digest("hex");
}

/** Publish only after the parent Responses completion fence, never on Native acceptance alone. */
export function rememberComposerPrediction(parsed: CodexParsedRequest, response: Record<string, unknown>, namespace: string,
  now = Date.now()): void {
  const suggestion = parsed._composerPrediction?.suggestion;
  if (response.status !== "completed" || !parsed._composerPrediction?.enabled
    || typeof suggestion !== "string" || !suggestion.trim() || suggestion.length > 2_000) return;
  const output = response.output as Array<{ type?: string; role?: string; phase?: string; content?: Array<{ type?: string; text?: string }> }>;
  const answer = output?.filter(item => item.type === "message" && item.role === "assistant"
    && item.phase !== "commentary").at(-1)?.content?.filter(part => part.type === "output_text").map(part => part.text).join("");
  const user = parsed.context.messages.findLast(message => message.role === "user" || message.role === "agentMessage");
  const digest = key(namespace, codexTurnMetadataFromBody(parsed._rawBody)?.thread_id, user, answer ?? "");
  if (!digest) return;
  const completedAt = parsed._composerPrediction.completedAt ??= now;
  const expiresAt = completedAt + COMPOSER_PREDICTION_TTL_MS;
  if (!Number.isFinite(completedAt) || completedAt > now || expiresAt <= now) return;
  for (const [id, entry] of entries) if (entry.expiresAt <= now) entries.delete(id);
  entries.delete(digest);
  while (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  entries.set(digest, { suggestion, expiresAt });
}

export function cachedComposerPrediction(body: unknown, namespace: string, now = Date.now()): string | null {
  try {
    const parsed = parseRequest(body);
    const index = parsed.context.messages.findLastIndex(message => message.role === "assistant" && message.phase !== "commentary");
    const assistant = parsed.context.messages[index];
    if (!assistant || assistant.role !== "assistant" || assistant.content.some(part => part.type !== "text")) return null;
    const answer = assistant.content.map(part => part.type === "text" ? part.text : "").join("");
    const user = parsed.context.messages.slice(0, index).findLast(message => message.role === "user" || message.role === "agentMessage");
    const digest = key(namespace, codexTurnMetadataFromBody(body)?.forked_from_thread_id, user, answer);
    const entry = digest ? entries.get(digest) : undefined;
    if (!entry || entry.expiresAt <= now) { if (digest) entries.delete(digest); return null; }
    return entry.suggestion;
  } catch { return null; }
}

/** Optional background requests are always local, including disabled/expired/incomplete history. */
export function composerPredictionResponse(body: Record<string, unknown>, config: AppConfig, namespace: string): Response {
  const suggestion = composerPredictionEnabled(config) ? cachedComposerPrediction(body, namespace) : null;
  const events: AdapterEvent[] = [{ type: "text_delta", text: JSON.stringify({ suggestion }), phase: "final_answer" },
    { type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }];
  const headers = { "X-Codex-Local-Handling": "composer-prediction-cache", "X-Codex-Response-Provenance": "local-auxiliary" };
  if (body.stream === true) {
    const stream = bridgeToResponsesSSE((async function* () { yield* events; })(), String(body.model));
    return new Response(stream, { headers: { ...headers, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  }
  return Response.json(buildResponseJSON(events, String(body.model)), { headers });
}
