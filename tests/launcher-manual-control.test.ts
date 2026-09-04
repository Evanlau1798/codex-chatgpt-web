import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL, LauncherBrowserTurnCancelledError } from "../src/launcher-browser-host";
import {
  startLauncherManualTurn, waitForLauncherManualSent, markLauncherManualTurnStarted,
  waitForLauncherManualTerminal, endLauncherManualTurn, LauncherManualTurnTimedOutError,
} from "../src/launcher-manual-control";

async function withControl(fetch: (request: Request) => Promise<Response>, run: (path: string) => Promise<void>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  const scratch = resolve(import.meta.dir, "../tmp");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "manual-client-"));
  const path = join(root, "descriptor.json");
  try {
    writeFileSync(path, JSON.stringify({
      version: 2, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production", pid: process.pid,
      endpoint: server.url.origin,
      control: { endpoint: server.url.origin, token: "launcher-control-token-0123456789abcdefghijklmnop" },
      helper: { executable: process.execPath, script: import.meta.path },
      partition: "persist:codex-web-gpt-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
      surfaceId: "launcher_surface_id_0123456789AB", createdAt: new Date().toISOString(),
    }), { mode: 0o600 });
    await run(path);
  } finally {
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

test("manual launcher control separates idempotent start from reconnectable Sent observation", async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  let sentPolls = 0;
  const lease = { tabId: "manual-tab", reused: false, deadlineAt: "2026-09-04T00:03:00.000Z", state: "awaiting-user" } as const;
  await withControl(async request => {
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe("Bearer launcher-control-token-0123456789abcdefghijklmnop");
    const path = new URL(request.url).pathname;
    requests.push({ path, body: await request.json() });
    if (path.endsWith("/start")) return Response.json({ ok: true, ...lease });
    if (path.endsWith("/wait-sent")) return sentPolls++ === 0
      ? Response.json({ status: "pending" }, { status: 202 })
      : Response.json({ status: "sent", sentAt: "2026-09-04T00:00:30.000Z" });
    if (path.endsWith("/started")) return Response.json({ ok: true });
    if (path.endsWith("/wait-terminal")) return Response.json({ status: "cancelled" });
    return Response.json({ ok: true, cancelledByUser: false });
  }, async path => {
    const owner = { traceId: "manual123456", helperPid: process.pid };
    await expect(startLauncherManualTurn(path, { ...owner, prompt: "private fixture prompt" })).resolves.toEqual(lease);
    await expect(waitForLauncherManualSent(path, owner)).resolves.toEqual({ sentAt: "2026-09-04T00:00:30.000Z" });
    await expect(markLauncherManualTurnStarted(path, owner)).resolves.toBeUndefined();
    await expect(waitForLauncherManualTerminal(path, owner)).resolves.toEqual({ status: "cancelled" });
    await expect(endLauncherManualTurn(path, { ...owner, status: "completed", retain: true }))
      .resolves.toEqual({ cancelledByUser: false });
    expect(requests).toEqual([
      { path: "/v1/manual/start", body: { ...owner, prompt: "private fixture prompt" } },
      { path: "/v1/manual/wait-sent", body: owner },
      { path: "/v1/manual/wait-sent", body: owner },
      { path: "/v1/manual/started", body: owner },
      { path: "/v1/manual/wait-terminal", body: owner },
      { path: "/v1/manual/end", body: { ...owner, status: "completed", retain: true } },
    ]);
  });
});

test("manual Sent wait preserves typed timeout and cancellation signals", async () => {
  for (const [status, code, errorType] of [
    [408, "manual_turn_timed_out", LauncherManualTurnTimedOutError],
    [409, "turn_cancelled", LauncherBrowserTurnCancelledError],
  ] as const) {
    let requests = 0;
    await withControl(async request => {
      expect(new URL(request.url).pathname).toBe("/v1/manual/wait-sent");
      await request.json();
      requests++;
      return Response.json({ error: "fixture terminal", code }, { status });
    }, async path => {
      await expect(waitForLauncherManualSent(path, { traceId: "manual123456", helperPid: process.pid }))
        .rejects.toBeInstanceOf(errorType);
      expect(requests).toBe(1);
    });
  }
});

test("manual mutations reconcile incomplete acknowledgements but never retry HTTP errors", async () => {
  const owner = { traceId: "manual_reconcile", helperPid: process.pid };
  const cases = [
    { run: (path: string) => startLauncherManualTurn(path, { ...owner, prompt: "fixture" }),
      ack: { ok: true, tabId: "tab", reused: false, deadlineAt: null, state: "awaiting-user" } },
    { run: (path: string) => markLauncherManualTurnStarted(path, owner), ack: { ok: true } },
    { run: (path: string) => endLauncherManualTurn(path, { ...owner, status: "completed" }),
      ack: { ok: true, cancelledByUser: false } },
  ];
  for (const entry of cases) {
    for (const status of [200, 409, 500]) {
      const bodies: unknown[] = [];
      await withControl(async request => {
        bodies.push(await request.json());
        return bodies.length === 1 ? Response.json({}, { status }) : Response.json(entry.ack);
      }, async path => {
        if (status === 200) {
          await entry.run(path);
          expect(bodies).toHaveLength(2);
          expect(bodies[0]).toEqual(bodies[1]);
        } else {
          await expect(entry.run(path)).rejects.toThrow(`HTTP ${status}`);
          expect(bodies).toHaveLength(1);
        }
      });
    }
    let calls = 0;
    await withControl(async request => {
      await request.json();
      calls++;
      return Response.json({});
    }, async path => {
      await expect(entry.run(path)).rejects.toThrow("invalid manual");
      expect(calls).toBe(2);
    });
  }
});
