import { timingSafeEqual } from "node:crypto";

export function lifecycleControlAuthorized(req: Request, controlToken: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${controlToken}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

interface LifecycleActivity {
  active_http_turns: number;
  active_browser_turns: number;
}

interface LifecycleControlDependencies {
  controlToken: string;
  activity: () => LifecycleActivity;
  isDraining: () => boolean;
  setDraining: (draining: boolean) => void;
  setExternalOwnersAccepted?: (accepted: boolean) => void;
  revokeExternalOwners?: () => number;
  cancelHttpTurns: (reason: unknown) => Promise<number>;
  cancelBrowserTurns: () => number;
  shutdown: () => void;
}

export async function handleLifecycleControlRequest(
  req: Request,
  pathname: string,
  dependencies: LifecycleControlDependencies,
): Promise<Response | null> {
  const supported = [
    "/admin/drain",
    "/admin/resume",
    "/admin/drain-if-idle",
    "/admin/cancel-turns",
    "/admin/shutdown",
  ].includes(pathname);
  if (req.method !== "POST" || !supported) return null;
  if (!lifecycleControlAuthorized(req, dependencies.controlToken)) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (pathname === "/admin/drain" || pathname === "/admin/resume") {
    const draining = pathname === "/admin/drain";
    dependencies.setDraining(draining);
    dependencies.setExternalOwnersAccepted?.(!draining);
    return Response.json({ status: "ok", accepting_turns: !draining, ...dependencies.activity() });
  }
  if (pathname === "/admin/drain-if-idle") {
    const current = dependencies.activity();
    if (dependencies.isDraining()) {
      return Response.json({ status: "draining", acquired: false, accepting_turns: false, ...current });
    }
    if (current.active_http_turns > 0 || current.active_browser_turns > 0) {
      return Response.json({ status: "busy", acquired: false, accepting_turns: true, ...current });
    }
    dependencies.setDraining(true);
    dependencies.setExternalOwnersAccepted?.(false);
    return Response.json({ status: "ok", acquired: true, accepting_turns: false, ...current });
  }
  if (pathname === "/admin/cancel-turns") {
    const cancelledBrowserTurns = dependencies.cancelBrowserTurns()
      + (dependencies.revokeExternalOwners?.() ?? 0);
    const cancelledHttpTurns = await dependencies.cancelHttpTurns(
      new Error("Active turn cancelled by launcher"),
    );
    return Response.json({
      status: "ok",
      cancelled_http_turns: cancelledHttpTurns,
      cancelled_browser_turns: cancelledBrowserTurns,
      ...dependencies.activity(),
    });
  }
  if (pathname === "/admin/shutdown") {
    const current = dependencies.activity();
    if (!dependencies.isDraining()
      || current.active_http_turns > 0
      || current.active_browser_turns > 0) {
      return Response.json(
        { status: "refused", accepting_turns: !dependencies.isDraining(), ...current },
        { status: 409 },
      );
    }
    setTimeout(dependencies.shutdown, 0);
    return Response.json({ status: "ok", accepting_turns: false, ...current });
  }
  return null;
}
