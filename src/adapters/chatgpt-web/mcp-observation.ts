import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { scopeHash } from "./mcp-request-diagnostics";

/** The model override only; prompts, names, items and other tool arguments stay private. */
export function subagentModelObservation(wireName: string, args?: Record<string, unknown>) {
  if (!/^(multi_agent_v[12]|collaboration)__spawn_agent$/.test(wireName)) return undefined;
  if (!args || !Object.hasOwn(args, "model")) return { modelOverride: "omitted" as const };
  const model = args.model;
  // Unknown model values remain visible as an explicit override without logging arbitrary input.
  return typeof model === "string" && /^(?:chatgpt-web\/)?gpt-[a-z0-9][a-z0-9._-]{0,79}$/.test(model)
    ? { modelOverride: "explicit" as const, requestedModel: model }
    : { modelOverride: "unrecognized" as const };
}

/** Content-free receipt/reply observations. A sent MCP result is not proof of tool execution. */
export function observeMcpToolCalls(
  transport: Transport,
  knownTools: ReadonlySet<string>,
  write: (event: Record<string, unknown>) => void = event => console.error(`[chatgpt-web-mcp] transport=${JSON.stringify(event)}`),
): Transport {
  let sequence = 0;
  let correlationSaturated = false;
  const pending = new Map<string | number, {
    call: number; tool: string; started: number; output_kind?: "commentary" | "reasoning" | "final";
    request_hash?: string; reference_hash?: string;
    ambiguousReplies?: number;
  }>();
  const emit = (event: Record<string, unknown>) => {
    // Logging is observational: a broken sink cannot change the invocation or its result.
    try { write({ at: new Date().toISOString(), pid: process.pid, ...event }); } catch { /* Preserve transport semantics. */ }
  };
  const receive = transport.onmessage;
  transport.onmessage = (message, extra) => {
    if ("method" in message && message.method === "tools/call" && "id" in message) {
      const name = message.params?.name;
      const tool = typeof name === "string" && knownTools.has(name) ? name : "unknown";
      if (pending.has(message.id)) {
        // An ambiguous protocol ID cannot safely correlate either reply.
        const call = pending.get(message.id)!;
        call.ambiguousReplies = (call.ambiguousReplies ?? 1) + 1;
        emit({ event: "uncorrelated_call", reason: "duplicate_id", tool });
      } else if (correlationSaturated || pending.size >= 1_024) {
        // Untracked in-flight IDs cannot safely be reused on this transport.
        correlationSaturated = true;
        emit({ event: "uncorrelated_call", reason: "tracking_limit", tool });
      } else {
        const args = message.params?.arguments;
        const outputArgs = args && typeof args === "object" && "wire_name" in args
          && args.wire_name === "codex.control.output" && "arguments" in args ? args.arguments : undefined;
        const kind = outputArgs && typeof outputArgs === "object" && "kind" in outputArgs ? outputArgs.kind : undefined;
        const output = tool === "codex_tool_call" && (kind === "commentary" || kind === "reasoning" || kind === "final")
          ? { output_kind: kind } as const : {};
        const reference = args && typeof args === "object"
          ? ("turn_token" in args ? args.turn_token : "request_id" in args ? args.request_id : undefined) : undefined;
        const correlation = {
          ...(String(message.id).length <= 256 ? { request_hash: scopeHash(`${typeof message.id}:${message.id}`) } : {}),
          ...(typeof reference === "string" && reference.length > 0 && reference.length <= 256
            ? { reference_hash: scopeHash(reference) } : {}),
        };
        const call = { call: ++sequence, tool, started: performance.now(), ...output, ...correlation };
        pending.set(message.id, call);
        emit({ event: "call_received", call: call.call, tool, ...output, ...correlation });
      }
    }
    receive?.(message, extra);
  };
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    const id = "id" in message ? message.id : undefined;
    const call = id !== undefined && id !== null && !("method" in message) ? pending.get(id) : undefined;
    const sendingAt = performance.now();
    try {
      await send(message, options);
      if (call && call.ambiguousReplies === undefined) {
        const result = "result" in message ? message.result : undefined;
        const { started: _, ambiguousReplies: __, ...receipt } = call;
        emit({
          event: "reply_sent", ...receipt,
          elapsed_ms: Math.round(performance.now() - call.started),
          ...(call.output_kind ? {
            output_kind: call.output_kind,
            handler_elapsed_ms: Math.round(sendingAt - call.started),
            send_elapsed_ms: Math.round(performance.now() - sendingAt),
          } : {}),
          outcome: "error" in message ? "protocol_error" : "result",
          ...("result" in message ? { is_error: result?.isError === true } : {}),
        });
      }
    } catch (error) {
      if (call && call.ambiguousReplies === undefined) {
        const { started: _, ambiguousReplies: __, ...receipt } = call;
        emit({ event: "reply_send_failed", ...receipt });
      }
      throw error;
    } finally {
      if (call && id !== undefined && id !== null && pending.get(id) === call) {
        if (call.ambiguousReplies === undefined || --call.ambiguousReplies === 0) pending.delete(id);
      }
    }
  };
  const close = transport.onclose;
  transport.onclose = () => {
    if (pending.size) emit({ event: "transport_closed", tracked_calls: pending.size });
    pending.clear();
    close?.();
  };
  return transport;
}
