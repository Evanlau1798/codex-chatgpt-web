import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL, LauncherBrowserTurnCancelledError,
} from "../src/launcher-browser-host";
import { LauncherManualTurnFailedError, LauncherManualTurnTimedOutError, startLauncherManualTurn } from "../src/launcher-manual-control";

const { BrowserControlServer } = require("../launcher/electron/control-server.cjs");
const { ManualTurnController } = require("../launcher/electron/manual-turn-controller.cjs");

for (const [terminal, status, code, errorClass] of [
  ["cancelled", 409, "turn_cancelled", LauncherBrowserTurnCancelledError],
  ["timeout", 408, "manual_turn_timed_out", LauncherManualTurnTimedOutError],
  ["failed", 409, "manual_turn_failed", LauncherManualTurnFailedError],
] as const) {
  test(`terminal ${terminal} retains its classification through controller, HTTP and client`, async () => {
    const logger = { info() {}, warn() {}, error() {} };
    const controller = new ManualTurnController({ host: { turnTabs: new Map() }, clipboard: {}, logger });
    controller.remember("trace-terminal", process.pid, terminal);
    const server = await new BrowserControlServer({
      logger, getPreferences: () => ({}), getBrowserHost: () => ({
        browserInteractionMode: () => "manual",
        beginManualTurn: (...args: unknown[]) => controller.begin(...args),
      }),
    }).start();
    const tmp = resolve(import.meta.dir, "../tmp");
    mkdirSync(tmp, { recursive: true });
    const root = mkdtempSync(join(tmp, "manual-control-errors-"));
    try {
      const control = server.descriptor();
      const path = join(root, "descriptor.json");
      writeFileSync(path, JSON.stringify({
        version: 2, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production", pid: process.pid,
        endpoint: "http://127.0.0.1:39110", control,
        helper: { executable: process.execPath, script: import.meta.path },
        partition: "persist:codex-web-gpt-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
        surfaceId: "launcher_surface_id_0123456789AB", createdAt: new Date().toISOString(),
      }), { mode: 0o600 });
      const activity = { traceId: "trace-terminal", helperPid: process.pid, prompt: "test" };
      const response = await fetch(`${control.endpoint}/v1/manual/start`, {
        method: "POST", headers: { authorization: `Bearer ${control.token}` },
        body: JSON.stringify(activity), signal: AbortSignal.timeout(3_000),
      });
      expect(response.status).toBe(status);
      expect((await response.json() as { code: string }).code).toBe(code);
      await expect(startLauncherManualTurn(path, activity, 3_000)).rejects.toBeInstanceOf(errorClass);
    } finally {
      server.server.closeAllConnections();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
