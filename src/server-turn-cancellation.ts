import { ChatGptWebAdapterError, chatGptBrowserTabClosedError } from "./adapters/chatgpt-web/adapter-error";
import { cancelAllStructuredCompactions, beginCancelStructuredCompactionTrace, cancelStructuredCompactionNativeTurn } from "./adapters/chatgpt-web/compaction-handoff";
import type { TurnBroker } from "./adapters/chatgpt-web/turn-broker";
import { chatGptTurnSessions } from "./adapters/chatgpt-web/turn-execution";
import type { HttpTurnCounter } from "./http-turn-counter";
import { lifecycleControlAuthorized } from "./lifecycle-control";

export async function handleTurnCancellation(
  req: Request,
  path: string,
  controlToken: string,
  httpTurns: HttpTurnCounter,
  broker: TurnBroker | undefined,
  activity: () => { active_http_turns: number; active_browser_turns: number },
): Promise<Response | undefined> {
  const browserIdleOnly = path === "/admin/cancel-turns-if-browser-idle";
  if (req.method !== "POST" || (!browserIdleOnly && !["/admin/interrupt-turn", "/admin/cancel-turn", "/admin/cancel-turns", "/admin/cancel-browser-turns"].includes(path))) return;
  if (!lifecycleControlAuthorized(req, controlToken)) return new Response("Unauthorized", { status: 401 });
  if (path === "/admin/interrupt-turn") {
    let threadId: string;
    let turnId: string;
    try {
      const body = await req.json() as { threadId?: unknown; turnId?: unknown };
      threadId = typeof body?.threadId === "string" ? body.threadId.trim() : "";
      turnId = typeof body?.turnId === "string" ? body.turnId.trim() : "";
      if (![threadId, turnId].every(id => /^[A-Za-z0-9_-]{6,128}$/.test(id))) throw new Error("Native turn identity is invalid");
    } catch (error) {
      return Response.json({ status: "error", error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
    const reason = new DOMException("Codex turn interrupted", "AbortError");
    const compaction = cancelStructuredCompactionNativeTurn(threadId, turnId, reason);
    const browser = chatGptTurnSessions.cancelNativeTurn(threadId, turnId, reason);
    const http = httpTurns.beginCancelTurn({ threadId, turnId }, reason);
    void Promise.allSettled([compaction.settlement, browser.settlement, http.settlement]).then(results => {
      for (const result of results) if (result.status === "rejected") console.error("[codex-chatgpt-web] interrupted turn cleanup failed");
    });
    return Response.json({ status: "ok", cancelled_http_turns: http.cancelled,
      cancelled_browser_turns: browser.cancelled, cancelled_compaction_runs: compaction.cancelled });
  }
  if (path === "/admin/cancel-turn") {
    let traceId: string;
    let leaseFailure: "browser_surface_bootstrap_timeout" | "helper_heartbeat_expired" | undefined;
    try {
      const body = await req.json() as { traceId?: unknown; reason?: unknown };
      traceId = typeof body?.traceId === "string" ? body.traceId : "";
      if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) throw new Error("traceId is invalid");
      if (body.reason !== undefined) {
        if (body.reason !== "browser_surface_bootstrap_timeout" && body.reason !== "helper_heartbeat_expired") {
          throw new Error("Browser turn cancellation reason is invalid");
        }
        leaseFailure = body.reason;
      }
    } catch (error) {
      return Response.json({ status: "error", error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
    const reason = leaseFailure
      ? new ChatGptWebAdapterError(
        leaseFailure === "browser_surface_bootstrap_timeout"
          ? "The ChatGPT browser turn did not finish browser setup before its lease expired. The turn was stopped."
          : "The ChatGPT browser helper stopped reporting progress and its lease expired. The turn was stopped.",
        { status: 504, errorType: "server_error", code: leaseFailure, retryable: false },
      )
      : chatGptBrowserTabClosedError();
    const compaction = beginCancelStructuredCompactionTrace(traceId, reason);
    const browser = chatGptTurnSessions.beginCancelTrace(traceId, reason);
    const brokerCount = broker?.revokeTrace(traceId, reason) ?? 0;
    const settlement = Promise.all([browser.settlement, compaction.settlement]);
    // Closing a tab must revoke authority before acknowledging UI destruction; lease expiry still
    // waits for physical cleanup. Both paths keep settlement owned by the existing session registry.
    if (leaseFailure) await settlement;
    else void settlement.catch(() => console.error("[codex-chatgpt-web] cancelled turn cleanup failed"));
    return Response.json({
      status: "ok", trace_id: traceId,
      cancelled_browser_turns: browser.cancelled,
      cancelled_broker_turns: brokerCount,
      cancelled_compaction_runs: compaction.cancelled,
      ...activity(),
    });
  }
  // No await between this check and cancellation: already-admitted requests may create a browser after drain.
  if (browserIdleOnly && activity().active_browser_turns !== 0) {
    return Response.json({ status: "busy", browser_idle: false, ...activity() }, { status: 409 });
  }
  const reason = new Error("Active turn cancelled by launcher");
  // Revoke compaction ownership first so source retirement cannot launch a new fallback.
  const compaction = cancelAllStructuredCompactions(reason);
  const browserCount = chatGptTurnSessions.clear() + (broker?.revokeExternalOwners() ?? 0);
  const [httpCount, compactionCount] = await Promise.all([
    path === "/admin/cancel-turns" || browserIdleOnly ? httpTurns.cancelAll(reason) : Promise.resolve(undefined),
    compaction,
  ]);
  return Response.json({
    status: "ok",
    ...(browserIdleOnly ? { browser_idle: true } : {}),
    ...(httpCount !== undefined ? { cancelled_http_turns: httpCount } : {}),
    cancelled_browser_turns: browserCount,
    cancelled_compaction_runs: compactionCount,
    ...activity(),
  });
}
