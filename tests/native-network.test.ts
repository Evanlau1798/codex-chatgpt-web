import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchNativeCodex, nativeProxyFromPac } from "../src/native-network";
import { LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

const envKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
  "NO_PROXY", "no_proxy", "CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR"];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
afterEach(() => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

test("native proxy selection preserves Chromium's first route and rejects protocol guessing", () => {
  expect(nativeProxyFromPac("DIRECT")).toBeUndefined();
  expect(nativeProxyFromPac("PROXY 127.0.0.1:7897; DIRECT")).toBe("http://127.0.0.1:7897/");
  expect(nativeProxyFromPac("HTTPS [::1]:8443")).toBe("https://[::1]:8443/");
  for (const value of ["", undefined, "SOCKS5 localhost:1080; PROXY localhost:8080", "PROXY user:secret@host:8", "PROXY host:8#secret"]) {
    expect(() => nativeProxyFromPac(value)).toThrow();
  }
});

test("native fetch reaches a proxy-only target, refreshes routing, and never retries a failed route", async () => {
  for (const key of envKeys) delete process.env[key];
  const root = mkdtempSync(join(tmpdir(), "native-network-"));
  const calls: { url: string; authorization: string | null; body: string }[] = [];
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    calls.push({ url: req.url, authorization: req.headers.get("authorization"), body: await req.text() });
    return new Response("data: response\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  let route = `PROXY 127.0.0.1:${proxy.port}`;
  let controlCalls = 0;
  let status = 200;
  let onResolve: (() => void) | undefined;
  const token = "launcher-control-token-0123456789abcdefghijklmnop";
  const control = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    controlCalls++;
    expect(new URL(req.url).pathname).toBe("/v1/network/resolve-proxy");
    expect(req.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(await req.json()).toEqual({ url: "http://native-proxy-regression.invalid/responses" });
    onResolve?.();
    return Response.json({ proxy: route }, { status });
  } });
  const descriptor = join(root, "launcher.json");
  writeFileSync(descriptor, JSON.stringify({
    version: 3, kind: "codex-web-gpt-launcher", profile: "production", pid: process.pid,
    endpoint: "http://127.0.0.1:39110", control: { endpoint: control.url.origin, token },
    helper: { executable: process.execPath, script: import.meta.path },
    partition: "persist:codex-web-gpt-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB", surfaceTargets: {}, createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  process.env.CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR = descriptor;
  const request = () => new Request("http://native-proxy-regression.invalid/responses", {
    method: "POST", body: "native request", headers: { authorization: "Bearer codex-test-only" },
    signal: AbortSignal.timeout(2000),
  });
  try {
    // The old bare-Bun path cannot reach this target at all.
    await expect(fetch(request())).rejects.toThrow();
    expect(await (await fetchNativeCodex(request())).text()).toContain("data: [DONE]");
    expect(calls).toEqual([{ url: request().url, authorization: "Bearer codex-test-only", body: "native request" }]);
    route = "DIRECT";
    await expect(fetchNativeCodex(request())).rejects.toThrow();
    route = "SOCKS5 127.0.0.1:1080; DIRECT";
    await expect(fetchNativeCodex(request())).rejects.toThrow("unsupported");
    status = 500;
    await expect(fetchNativeCodex(request())).rejects.toThrow("HTTP 500");
    expect(calls).toHaveLength(1);
    expect(controlCalls).toBe(4);
    status = 200;
    route = `PROXY 127.0.0.1:${proxy.port}`;
    const abort = new AbortController();
    onResolve = () => abort.abort();
    await expect(fetchNativeCodex(new Request(request(), { signal: abort.signal }))).rejects.toThrow();
    onResolve = undefined;
    expect(calls).toHaveLength(1);
    expect(controlCalls).toBe(5);
    // Explicit environment configuration remains authoritative, even with an unavailable launcher.
    const child = Bun.spawn([process.execPath, "-e", `
      const { fetchNativeCodex } = await import(${JSON.stringify(new URL("../src/native-network.ts", import.meta.url).href)});
      console.log(await (await fetchNativeCodex(new Request("http://native-proxy-regression.invalid/responses"))).text());
    `], { env: { ...process.env, HTTP_PROXY: proxy.url.origin }, stdout: "pipe", stderr: "pipe" });
    const childOutput = await new Response(child.stdout).text();
    const childError = await new Response(child.stderr).text();
    expect({ code: await child.exited, error: childError }).toEqual({ code: 0, error: "" });
    expect(childOutput).toContain("[DONE]");
    expect(controlCalls).toBe(5);
    expect(calls).toHaveLength(2);
    delete process.env.CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR;
    await expect(fetchNativeCodex(request())).rejects.toThrow();
    expect(controlCalls).toBe(5);
  } finally {
    control.stop(true);
    proxy.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
