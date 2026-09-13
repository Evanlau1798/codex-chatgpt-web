import { callTurnBroker } from "./turn-broker-client";
import type { BrokerTurnOutputKind } from "./turn-broker-protocol";
import type { CodexParsedRequest } from "../../types";

export const CODEX_OUTPUT_CONTROL_WIRE_NAME = "codex.control.output";

export const CODEX_OUTPUT_CONTROL_PROMPT = [
  "codex.control.output is a bound bridge control supplied here, not an inventory tool; no inventory lookup is needed. The inventory-discovery rule for work tools does not apply to this bound control. Call it directly through codex_tool_call with the current bound turn_token and arguments containing kind and text.",
  "Send every user-visible progress update through codex_tool_call with wire_name codex.control.output, arguments kind=commentary and the complete visible text. Do not also write that text as ordinary assistant prose.",
  "At task startup, for work requiring tools: After reading and merging the required context, promptly send one brief task-facing commentary through this control before extended planning, unless the user requested silence. Then discover and invoke the first authorized, bounded read needed for the task. Batch independent bounded reads when useful; read skill references only when their entrypoint requires them. Preserve applicable instructions and approvals; do not expose transport details or hidden reasoning. Tasks needing no tools can proceed directly to their answer.",
  "Send only user-visible reasoning summaries, never hidden chain-of-thought, with kind=reasoning.",
  "After all work tools have settled, send the complete user-facing answer exactly once with kind=final. An accepted=true acknowledgement with sequence confirms the bridge queued the text; it is not a UI render receipt. After final acknowledgement, end this Web response so the bridge can validate completion and deliver the answer. Do not wait for a render echo, poll, repeat the final, write assistant prose, or call another tool.",
  "Use the current codex_native_turn_binding turn_token for every output control call. Output control calls report text to the outer Codex task and do not authorize additional work.",
] as const;

export function shouldUseEnhancedOutputTunnel(
  parsed: CodexParsedRequest,
  options: {
    requested: boolean;
    localTools: boolean;
    toolCount: number;
    luna: boolean;
    manualControl?: boolean;
    captureLunaCheckpoint?: boolean;
    multipart?: boolean;
  },
): boolean {
  return options.requested && options.localTools && options.toolCount > 0
    && !options.luna && !parsed._compactionRequest
    && !options.manualControl && !options.captureLunaCheckpoint && !options.multipart;
}

export async function submitNativeOutputControl(
  socketPath: string,
  token: string,
  args: Record<string, unknown> | undefined,
  input: string | undefined,
  signal?: AbortSignal,
): Promise<{ accepted: true; sequence: number; duplicate: boolean }> {
  if (input !== undefined) throw new Error("Codex Native output control does not accept freeform input");
  if (!args || Object.keys(args).some(key => key !== "kind" && key !== "text")) {
    throw new Error("Codex Native output control accepts only kind and text");
  }
  const kind = args.kind;
  const text = args.text;
  if (!isKind(kind)) throw new Error("Codex Native output control kind is invalid");
  if (typeof text !== "string" || text.length === 0 || text.length > 1_000_000) {
    throw new Error("Codex Native output control text is invalid");
  }
  return callTurnBroker(socketPath, {
    method: "submit_output", token, outputKind: kind, outputText: text,
  }, 5_000, signal);
}

function isKind(value: unknown): value is BrokerTurnOutputKind {
  return value === "commentary" || value === "reasoning" || value === "final";
}
