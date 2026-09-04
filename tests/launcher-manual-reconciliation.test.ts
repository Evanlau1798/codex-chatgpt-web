import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAUNCHER_BROWSER_HOST_KIND,
  LAUNCHER_BROWSER_IDLE_URL,
  LauncherBrowserTurnCancelledError,
  inspectLauncherBrowserHost,
  notifyLauncherTurn,
  readLauncherBrowserHostDescriptor,
  releaseLauncherRetainedConversation,
  selectLauncherPage,
  verifyLauncherBrowserConnector,
} from "../src/launcher-browser-host";
import { startLauncherManualTurn, markLauncherManualTurnStarted, endLauncherManualTurn } from "../src/launcher-manual-control";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function descriptorFile(
  controlEndpoint = "http://127.0.0.1:39111",
  profile: "production" | "development" = "production",
): string {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-descriptor-"));
  roots.push(root);
  const path = join(root, "launcher-browser.json");
  writeFileSync(path, `${JSON.stringify({
    version: 2,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile,
    pid: process.pid,
    endpoint: "http://127.0.0.1:39110",
    control: {
      endpoint: controlEndpoint,
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: {
      executable: process.execPath,
      script: import.meta.path,
    },
    partition: profile === "development"
      ? "persist:codex-web-gpt-dev-chatgpt"
      : "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB",
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  return path;
}

test("manual launcher mutations reconcile one lost local response with the same turn owner", async () => {
  const attempts = new Map<string, number>();
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    const url = request.url ?? "";
    const attempt = (attempts.get(url) ?? 0) + 1;
    attempts.set(url, attempt);
    if (attempt === 1) {
      response.destroy();
      return;
    }
    response.setHeader("content-type", "application/json");
    if (url === "/v1/manual/start") {
      response.end(JSON.stringify({
        ok: true,
        tabId: "manual-tab",
        reused: true,
        deadlineAt: "2026-08-30T00:01:00.000Z",
        state: "awaiting-user",
      }));
      return;
    }
    if (url === "/v1/manual/started") {
      response.end('{"ok":true}');
      return;
    }
    response.end('{"ok":true,"cancelledByUser":false}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    const owner = { traceId: "manual_reconcile", helperPid: process.pid };
    await expect(startLauncherManualTurn(path, { ...owner, prompt: "private prompt" }, 500))
      .resolves.toMatchObject({ tabId: "manual-tab", reused: true });
    await expect(markLauncherManualTurnStarted(path, owner, 500)).resolves.toBeUndefined();
    await expect(endLauncherManualTurn(path, { ...owner, status: "completed" }, 500))
      .resolves.toEqual({ cancelledByUser: false });
    expect(Object.fromEntries(attempts)).toEqual({
      "/v1/manual/start": 2,
      "/v1/manual/started": 2,
      "/v1/manual/end": 2,
    });
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
});
