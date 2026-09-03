import { chatGptBrowserTabClosedError } from "./adapters/chatgpt-web/adapter-error";
import { cancelAllStructuredCompactions, cancelStructuredCompactionTrace } from "./adapters/chatgpt-web/compaction-handoff";
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
  if (req.method !== "POST" || !["/admin/cancel-turn", "/admin/cancel-turns", "/admin/cancel-browser-turns"].includes(path)) return;
  if (!lifecycleControlAuthorized(req, controlToken)) return new Response("Unauthorized", { status: 401 });
  if (path === "/admin/cancel-turn") {
    let traceId: string;
    try {
      const body = await req.json() as { traceId?: unknown };
      traceId = typeof body?.traceId === "string" ? body.traceId : "";
      if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) throw new Error("traceId is invalid");
    } catch (error) {
      return Response.json({ status: "error", error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
    const reason = chatGptBrowserTabClosedError();
    const compaction = cancelStructuredCompactionTrace(traceId, reason);
    const [browserCount, compactionCount] = await Promise.all([
      chatGptTurnSessions.cancelTrace(traceId, reason), compaction,
    ]);
    return Response.json({
      status: "ok", trace_id: traceId,
      cancelled_browser_turns: browserCount,
      cancelled_broker_turns: broker?.revokeTrace(traceId, reason) ?? 0,
      cancelled_compaction_runs: compactionCount,
      ...activity(),
    });
  }
  const reason = new Error("Active turn cancelled by launcher");
  // Revoke compaction ownership first so source retirement cannot launch a new fallback.
  const compaction = cancelAllStructuredCompactions(reason);
  const browserCount = chatGptTurnSessions.clear() + (broker?.revokeExternalOwners() ?? 0);
  const [httpCount, compactionCount] = await Promise.all([
    path === "/admin/cancel-turns" ? httpTurns.cancelAll(reason) : Promise.resolve(undefined),
    compaction,
  ]);
  return Response.json({
    status: "ok",
    ...(httpCount !== undefined ? { cancelled_http_turns: httpCount } : {}),
    cancelled_browser_turns: browserCount,
    cancelled_compaction_runs: compactionCount,
    ...activity(),
  });
}
