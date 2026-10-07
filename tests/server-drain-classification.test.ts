import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { classifyError, httpStatusFromTerminalError } from "../src/lib/errors";
import { startServer } from "../src/server";

test("local drain is distinct from actual provider overload", () => {
  expect(classifyError(503, "service_draining", "Service is draining")).toEqual({
    message: "Service is draining", type: "server_error", code: "service_draining",
  });
  expect(classifyError(503, "server_error", "Provider is overloaded").code).toBe("server_is_overloaded");
  expect(classifyError(401, "service_draining", "Unauthorized").code).toBe("invalid_api_key");
  expect(httpStatusFromTerminalError(classifyError(503, "service_draining", "Service is draining"))).toBe(503);
});

test("drained native HTTP routes report service_draining without admitting new work", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { authorization: `Bearer ${config.controlToken}` };
  try {
    const drain = await fetch(`${base}/admin/drain`, { method: "POST", headers });
    expect(drain.status).toBe(200);
    const failures: Array<{ path: string; code: string }> = [];
    for (const [method, path] of [
      ["GET", "/v1/models"], ["POST", "/v1/responses"], ["POST", "/v1/messages"],
      ["POST", "/v1/responses/compact"], ["POST", "/v1/images/edits"],
    ]) {
      const response = await fetch(`${base}${path}`, {
        method,
        ...(method === "POST" ? path === "/v1/images/edits"
          ? { body: new FormData() }
          : { body: "{}", headers: { "content-type": "application/json" } } : {}),
      });
      expect(response.status).toBe(503);
      const payload = await response.json() as { error: { type: string; code: string } };
      expect(payload.error.type).toBe("server_error");
      if (payload.error.code !== "service_draining") failures.push({ path: path!, code: payload.error.code });
    }
    expect(failures).toEqual([]);
    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({
      accepting_turns: false, active_http_turns: 0, active_browser_turns: 0,
    });
    expect((await fetch(`${base}/admin/resume`, { method: "POST", headers })).status).toBe(200);
    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ accepting_turns: true });
  } finally { await server.stop(true); }
});
