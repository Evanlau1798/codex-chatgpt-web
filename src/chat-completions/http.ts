import { randomUUID, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config";
import { ChatGptWebAdapterError } from "../adapters/chatgpt-web/adapter-error";
import { parseChatCompletion, decodeChatCompletion, ChatCompletionError, type ChatCompletionInput } from "./contract";
import { chatCompletionRoutes, createChatCompletionExecutor, prepareChatCompletion, requireChatCompletionAvailability, type ChatCompletionExecutor } from "./runtime";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1", "::ffff:127.0.0.1"]);
const ROUTES = new Set(["/v1/models", "/v1/chat/completions"]);
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_STREAM_QUEUE_BYTES = 4 * 1024 * 1024;

/** This key is listener-scoped admission, not an account credential or native capability. */
export function chatCompletionApiKey(config: AppConfig, value = process.env.CODEX_CHATGPT_WEB_API_KEY): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^[\x21-\x7e]{32,512}$/.test(value) || value === config.controlToken
    || config.host !== "127.0.0.1") throw new Error("Chat Completions requires a distinct 32..512-character API key and a loopback listener");
  return value;
}
export function isChatCompletionKey(req: Request, key: string | undefined): boolean {
  if (!key) return false;
  const expected = Buffer.from(key);
  const actual = Buffer.from(/^Bearer ([^\s]+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "");
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}

export function chatCompletionErrorResponse(error: unknown): Response {
  const { status, body } = publicChatError(error);
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
export function publicChatError(error: unknown): { status: number; body: { error: { message: string; type: string; code: string; param: string | null } } } {
  let status = 502, code = "web_backend_error", message = "The Web model request failed; completion could not be confirmed", param: string | null = null;
  if (error instanceof ChatCompletionError) { ({ status, code, message, param } = error); }
  else if (error instanceof ChatGptWebAdapterError) {
    // Do not expose arbitrary browser exception messages, DOM excerpts, paths, or tool arguments.
    if (error.code === "rate_limit_exceeded" || error.code === "chatgpt_account_safety_stop") {
      status = 429; code = error.code; message = "The Web service rejected the request; automatic retries are not performed";
    } else if (error.code === "chatgpt_prompt_integrity_mismatch") {
      code = error.code; message = "The composer did not preserve the request; no verified completion is available";
    }
  } else if (error instanceof Error && error.name === "AbortError") {
    status = 499; code = "request_cancelled"; message = "Request cancelled";
  }
  return { status, body: { error: { message, type: status === 401 ? "authentication_error" : status === 403 ? "permission_error"
    : status === 429 ? "rate_limit_error" : status >= 500 ? "server_error" : "invalid_request_error", code, param } } };
}

/** General-key scope is enforced before native/admin route dispatch, including read routes. */
export function chatCompletionRequestGuard(req: Request, path: string, key: string | undefined,
  port: number, peerAddress?: string): Response | undefined {
  const recognized = isChatCompletionKey(req, key);
  if (!recognized && path !== "/v1/chat/completions") return undefined;
  if (!key) return chatCompletionErrorResponse(new ChatCompletionError("Chat Completions is disabled", 404, "api_disabled"));
  if (!recognized) return chatCompletionErrorResponse(new ChatCompletionError("Invalid API key", 401, "invalid_api_key"));
  if (!ROUTES.has(path)) return chatCompletionErrorResponse(new ChatCompletionError("This API key cannot access that route", 403, "route_not_allowed"));
  try {
    const host = new URL(`http://${req.headers.get("host") ?? ""}`);
    if (!LOOPBACK.has(host.hostname.toLowerCase()) || (host.port || "80") !== String(port)
      || host.username || host.password || host.pathname !== "/"
      || (peerAddress !== undefined && !LOOPBACK.has(peerAddress))) throw new Error();
    if (req.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") throw new Error();
    const origin = req.headers.get("origin");
    if (origin !== null) {
      const from = new URL(origin);
      if (!LOOPBACK.has(from.hostname.toLowerCase()) || (from.port || (from.protocol === "https:" ? "443" : "80")) !== String(port)
        || from.username || from.password
        || !["http:", "https:"].includes(from.protocol)) throw new Error();
    }
  } catch { return chatCompletionErrorResponse(new ChatCompletionError("Only same-origin loopback API requests are allowed", 403, "local_request_required")); }
  if ((path === "/v1/models" && req.method !== "GET") || (path === "/v1/chat/completions" && req.method !== "POST")) {
    return chatCompletionErrorResponse(new ChatCompletionError("Method not supported", 405, "method_not_allowed"));
  }
  if (req.method === "POST") {
    const media = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (media !== "application/json") return chatCompletionErrorResponse(new ChatCompletionError("Use application/json", 415, "unsupported_media_type"));
    if ((req.headers.get("content-encoding") ?? "identity") !== "identity") return chatCompletionErrorResponse(new ChatCompletionError("Compressed request bodies are not supported", 415, "unsupported_encoding"));
  }
  return undefined;
}
async function readBody(req: Request, signal: AbortSignal): Promise<unknown> {
  if (!req.body) throw new ChatCompletionError("Missing JSON body");
  const length = req.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new ChatCompletionError("Request body exceeds the byte limit", 413, "body_too_large");
  const reader = req.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0, value = "";
  const cancelled = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancelled, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_BODY_BYTES) throw new ChatCompletionError("Request body exceeds the byte limit", 413, "body_too_large");
      value += decoder.decode(chunk.value, { stream: true });
    }
    value += decoder.decode();
    return JSON.parse(value);
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof ChatCompletionError) throw error;
    throw new ChatCompletionError("Expected valid UTF-8 JSON", 400, "invalid_json");
  } finally { signal.removeEventListener("abort", cancelled); reader.releaseLock(); }
}
export function chatCompletionModels(config: AppConfig): Response {
  return Response.json({ object: "list", data: chatCompletionRoutes(config).map(route => ({
    id: route.slug, object: "model", created: 0, owned_by: "chatgpt-web",
  })) }, { headers: { "cache-control": "no-store" } });
}

export async function chatCompletionRequest(req: Request, config: AppConfig, signal: AbortSignal,
  execute: ChatCompletionExecutor = createChatCompletionExecutor()): Promise<Response> {
  let input: ChatCompletionInput;
  try { input = parseChatCompletion(await readBody(req, AbortSignal.any([signal, AbortSignal.timeout(30_000)]))); prepareChatCompletion(input, config); requireChatCompletionAvailability(config); signal.throwIfAborted(); }
  catch (error) { return chatCompletionErrorResponse(error); }
  const identity = { id: `chatcmpl_${randomUUID().replaceAll("-", "")}`, created: Math.floor(Date.now() / 1000), model: input.model };
  if (!input.stream) {
    try {
      const output = await execute(input, config, signal, () => {}); signal.throwIfAborted();
      const result = decodeChatCompletion(input, output.answer, output.limited);
      return Response.json({ ...identity, object: "chat.completion", choices: [{ index: 0,
        message: { role: "assistant", content: result.content, ...(result.tool_calls ? { tool_calls: result.tool_calls } : {}) },
        finish_reason: result.finishReason }] }, { headers: { "cache-control": "no-store" } });
    } catch (error) { return chatCompletionErrorResponse(error); }
  }
  const abort = new AbortController();
  const combined = AbortSignal.any([signal, abort.signal]);
  const encoder = new TextEncoder();
  let running: Promise<void> | undefined;
  let cancelled = false;
  let transportFailed = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (bytes: Uint8Array) => {
        if (cancelled || transportFailed || combined.aborted) return;
        if ((controller.desiredSize ?? 0) < bytes.byteLength) {
          // Stop producing rather than buffering unbounded SSE overhead for a stalled consumer.
          const error = new ChatCompletionError("Response consumer exceeded the bounded stream queue", 502, "stream_consumer_stalled");
          transportFailed = true; abort.abort(error); controller.error(error); return;
        }
        controller.enqueue(bytes);
      };
      const send = (data: unknown) => enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => send({ ...identity,
        object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] });
      running = (async () => {
        let emitted = "";
        try {
          chunk({ role: "assistant", content: "" });
          const output = await execute(input, config, combined, delta => {
            if (input.tools.length && input.toolChoice !== "none") return;
            combined.throwIfAborted(); emitted += delta; chunk({ content: delta });
          });
          combined.throwIfAborted();
          const result = decodeChatCompletion(input, output.answer, output.limited);
          const finalText = result.content ?? "";
          if (!finalText.startsWith(emitted)) throw new ChatCompletionError("Model output changed after streaming began", 502, "model_output_changed");
          if (finalText.length > emitted.length) chunk({ content: finalText.slice(emitted.length) });
          if (result.tool_calls?.length) chunk({ tool_calls: result.tool_calls.map((call, index) => ({ index, ...call })) });
          chunk({}, result.finishReason);
          enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (error) {
          // An SDK-visible error is terminal, never followed by success finish_reason or [DONE].
          if (!cancelled && !combined.aborted) send(publicChatError(error).body);
        } finally { if (!cancelled && !transportFailed) controller.close(); }
      })();
    },
    async cancel() { cancelled = true; abort.abort(new DOMException("Client stream cancelled", "AbortError")); await running; },
  }, new ByteLengthQueuingStrategy({ highWaterMark: MAX_STREAM_QUEUE_BYTES }));
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
