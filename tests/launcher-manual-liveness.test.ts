import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  inspectLauncherBrowserHostLiveness,
  LAUNCHER_BROWSER_HOST_KIND,
  LAUNCHER_BROWSER_IDLE_URL,
} from "../src/launcher-browser-host";

test("manual launcher liveness reads metadata only and rejects a wrong profile or non-loopback CDP", async () => {
  const requests: Array<{ path: string; method: string; authorization: string | null }> = [];
  let websocket = "ws://127.0.0.1:39110/devtools/browser/test";
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      requests.push({ path: new URL(request.url).pathname, method: request.method,
        authorization: request.headers.get("authorization") });
      return Response.json({ webSocketDebuggerUrl: websocket });
    },
  });
  const scratch = resolve(import.meta.dir, "../tmp");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "manual-liveness-"));
  const path = join(root, "descriptor.json");
  writeFileSync(path, JSON.stringify({
    version: 2, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production", pid: process.pid,
    endpoint: server.url.origin,
    control: { endpoint: server.url.origin, token: "launcher-control-token-0123456789abcdefghijklmnop" },
    helper: { executable: process.execPath, script: import.meta.path },
    partition: "persist:codex-web-gpt-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB", createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  try {
    await expect(inspectLauncherBrowserHostLiveness(path, { expectedProfile: "development" }))
      .rejects.toThrow("production, but development was required");
    expect(requests).toEqual([]);
    const descriptor = await inspectLauncherBrowserHostLiveness(path, { expectedProfile: "production" });
    expect(descriptor.profile).toBe("production");
    expect(requests).toEqual([{ path: "/json/version", method: "GET", authorization: null }]);
    websocket = "ws://example.invalid/devtools/browser/test";
    await expect(inspectLauncherBrowserHostLiveness(path)).rejects.toThrow("loopback WebSocket");
    expect(requests).toHaveLength(2);
    expect(requests.every(request => request.path === "/json/version" && request.method === "GET")).toBe(true);
  } finally {
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
