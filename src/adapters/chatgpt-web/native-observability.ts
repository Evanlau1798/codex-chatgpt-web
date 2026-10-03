import { createHash } from "node:crypto";
import type { BrokerToolRequest, BrokerToolResult } from "./turn-broker-protocol";

export function nativeToolResultReceipt(request: BrokerToolRequest, result: BrokerToolResult) {
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  const exit = ["exec_command", "shell_command", "Bash"].includes(request.wireName)
    && structured && typeof structured === "object" && Number.isSafeInteger(structured.exit_code)
    ? structured.exit_code as number : undefined;
  let outputHash: string | undefined;
  try { outputHash = createHash("sha256").update(JSON.stringify(result.content)).digest("hex"); } catch { /* telemetry cannot discard the native result */ }
  return { version: 1, call_id: request.callId, wire_name: request.wireName, result_state: "returned" as const,
    is_error: result.isError === true, execution_status: exit === undefined ? "not_reported" : "reported_exit",
    ...(exit !== undefined ? { exit_code: exit } : {}),
    ...(outputHash ? { output_sha256: outputHash } : { output_hash_unavailable: true }) };
}

export function logNativeWorkflow(traceId: string, event: Record<string, unknown>) {
  // Callers construct allowlisted fields; no arbitrary error messages, arguments, tokens or content.
  try { console.info(`[chatgpt-web] native_workflow ${JSON.stringify({ version: 1, traceId, at: Date.now(), ...event })}`); }
  catch { /* logging is not a completion or tool transport boundary */ }
}

export class NativeWorkflowSignals {
  private last?: string;
  constructor(private readonly traceId: string) {}
  observe(running: boolean, activeTools: number) {
    const phase = activeTools > 0 ? "tool_running" : running ? "provider_running" : "waiting_unobserved";
    if (phase === this.last) return;
    this.last = phase;
    logNativeWorkflow(this.traceId, { phase, source: activeTools > 0 ? "broker_activity" : "visible_stop_control",
      transport_heartbeat_is_progress: false, active_tools: activeTools });
  }
}
