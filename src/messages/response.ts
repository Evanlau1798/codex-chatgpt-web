import { createHash, randomUUID } from "node:crypto";
import type { AdapterEvent, CodexUsage } from "../types";

type Content = Record<string, unknown>;

export interface ClaudeResponseMeta {
  model: string;
  inputTokens: number;
}

function stopReason(reason?: string): string {
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens" || reason === "max_output_tokens" || reason === "length") return "max_tokens";
  return "end_turn";
}

export function anthropicError(message: string, status = 400, type = "invalid_request_error"): Response {
  return Response.json({ type: "error", error: { type, message }, request_id: randomUUID() }, { status });
}

export function buildClaudeMessage(events: AdapterEvent[], meta: ClaudeResponseMeta): Response {
  const content: Content[] = [];
  let text = "";
  let thinking = "";
  let thinkingSignature = "";
  let tool: { id: string; name: string; json: string } | undefined;
  let usage: CodexUsage | undefined;
  let reason: string | undefined;
  const flush = () => {
    if (thinking) {
      content.push({ type: "thinking", thinking, signature: thinkingSignature || createHash("sha256").update(thinking).digest("base64url") });
      thinking = "";
      thinkingSignature = "";
    }
    if (text) {
      content.push({ type: "text", text });
      text = "";
    }
    if (tool) {
      let input: unknown = {};
      try { input = JSON.parse(tool.json || "{}"); } catch { input = {}; }
      content.push({ type: "tool_use", id: tool.id, name: tool.name, input });
      tool = undefined;
    }
  };
  for (const event of events) {
    if (event.type === "thinking_delta") thinking += event.thinking;
    else if (event.type === "thinking_signature") thinkingSignature = event.signature;
    else if (event.type === "redacted_thinking") { flush(); content.push({ type: "redacted_thinking", data: event.data }); }
    else if (event.type === "text_delta") text += event.text;
    else if (event.type === "tool_call_start") { flush(); tool = { id: event.id, name: event.name, json: "" }; }
    else if (event.type === "tool_call_delta" && tool) tool.json += event.arguments;
    else if (event.type === "tool_call_end") flush();
    else if (event.type === "done") { usage = event.usage; reason = event.stopReason; }
    else if (event.type === "incomplete") { usage = event.usage; reason = event.reason; }
    else if (event.type === "error") return anthropicError(event.message, event.status ?? 500, event.errorType ?? "api_error");
  }
  flush();
  return Response.json({
    id: `msg_${randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model: meta.model,
    content,
    stop_reason: stopReason(reason),
    stop_sequence: null,
    usage: { input_tokens: usage?.inputTokens ?? meta.inputTokens, output_tokens: usage?.outputTokens ?? 0 },
  });
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function streamClaudeMessage(
  events: AsyncIterable<AdapterEvent>,
  meta: ClaudeResponseMeta,
  onCancel?: () => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const id = `msg_${randomUUID().replaceAll("-", "")}`;
  const startedAt = Date.now();
  let cancelled = false;
  return new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (!cancelled) controller.enqueue(encoder.encode(frame(event, data)));
      };
      let index = -1;
      let kind: "text" | "thinking" | "tool" | undefined;
      let thinking = "";
      let thinkingSignature = "";
      let usage: CodexUsage | undefined;
      let firstTextLogged = false;
      const closeBlock = () => {
        if (!kind) return;
        if (kind === "thinking") send("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: thinkingSignature || createHash("sha256").update(thinking).digest("base64url") } });
        send("content_block_stop", { type: "content_block_stop", index });
        kind = undefined;
        thinking = "";
        thinkingSignature = "";
      };
      send("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: meta.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: meta.inputTokens, output_tokens: 0 } } });
      try {
        for await (const event of events) {
          if (event.type === "heartbeat") send("ping", { type: "ping" });
          else if (event.type === "thinking_delta") {
            if (kind === "text") continue;
            if (kind !== "thinking") { closeBlock(); index += 1; kind = "thinking"; send("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } }); }
            thinking += event.thinking;
            send("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: event.thinking } });
          } else if (event.type === "thinking_signature") {
            thinkingSignature = event.signature;
          } else if (event.type === "redacted_thinking") {
            closeBlock(); index += 1;
            send("content_block_start", { type: "content_block_start", index, content_block: { type: "redacted_thinking", data: event.data } });
            send("content_block_stop", { type: "content_block_stop", index });
          } else if (event.type === "text_delta") {
            if (!firstTextLogged) {
              firstTextLogged = true;
              console.info(`[chatgpt-web] Claude SSE latency stage=first_text_enqueue elapsedMs=${Date.now() - startedAt}`);
            }
            if (kind !== "text") { closeBlock(); index += 1; kind = "text"; send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }); }
            send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: event.text } });
          } else if (event.type === "tool_call_start") {
            closeBlock(); index += 1; kind = "tool";
            send("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: event.id, name: event.name, input: {} } });
          } else if (event.type === "tool_call_delta" && kind === "tool") {
            send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: event.arguments } });
          } else if (event.type === "tool_call_end") closeBlock();
          else if (event.type === "error") {
            closeBlock();
            send("error", { type: "error", error: { type: event.errorType ?? "api_error", message: event.message } });
            if (!cancelled) controller.close();
            return;
          }
          else if (event.type === "done") {
            usage = event.usage;
            closeBlock();
            send("message_delta", { type: "message_delta", delta: { stop_reason: stopReason(event.stopReason), stop_sequence: null }, usage: { output_tokens: usage?.outputTokens ?? 0 } });
          } else if (event.type === "incomplete") {
            usage = event.usage;
            closeBlock();
            send("message_delta", { type: "message_delta", delta: { stop_reason: stopReason(event.reason), stop_sequence: null }, usage: { output_tokens: usage?.outputTokens ?? 0 } });
          }
        }
        if (!cancelled) {
          send("message_stop", { type: "message_stop" });
          controller.close();
        }
      } catch (error) {
        if (cancelled) return;
        send("error", { type: "error", error: { type: "api_error", message: error instanceof Error ? error.message : String(error) } });
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
      onCancel?.();
    },
  });
}
