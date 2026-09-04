import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { createRequire } from "node:module";
const { RuntimeSupervisor } = createRequire(import.meta.url)("../launcher/electron/runtime-supervisor.cjs");

test("mode switching cancels HTTP-only work before the real authenticated shutdown", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let aborted = false;
  const server = startServer(config, { fetchUpstream: async request => {
    entered();
    await new Promise<void>(resolve => request.signal.addEventListener("abort", () => {
      aborted = true;
      resolve();
    }, { once: true }));
    return Response.json({ error: "cancelled" }, { status: 503 });
  } });
  config.port = server.port!;
  const endpoint = `http://127.0.0.1:${server.port}`;
  const request = fetch(`${endpoint}/v1/alpha/search`, {
    method: "POST", headers: { authorization: "Bearer fixture-session", "content-type": "application/json" },
    body: JSON.stringify({ query: "fixture" }),
  }).then(response => response.text(), () => undefined);
  const supervisor = new RuntimeSupervisor({ app: { getPath: () => process.cwd(), getVersion: () => "5.0.0" },
    sourceRoot: process.cwd(), coreHome: process.cwd(), logger: { info() {}, warn() {}, error() {} } });
  supervisor.readConfig = () => config;
  supervisor.readState = () => null;
  supervisor.proxyHealth = async () => true;
  supervisor.daemon = { pid: process.pid, exitCode: null, signalCode: null };
  // The listener is in-process; production control, admission, cancellation and shutdown remain real.
  supervisor.waitForChildExit = async () => {};
  supervisor.clearState = () => {};
  supervisor.tryWriteState = () => {};
  supervisor.ownedRuntimeReady = async () => false;
  try {
    await ready;
    expect(await (await fetch(`${endpoint}/healthz`)).json()).toMatchObject({
      active_http_turns: 1, active_browser_turns: 0,
    });
    await supervisor.stopForSetup({ browserOnly: true });
    expect(aborted).toBe(true);
    expect(supervisor.daemon).toBeNull();
    await request;
  } finally {
    if (!aborted) await supervisor.control(config, "cancel-turns").catch(() => {});
    await request;
    await server.stop(true);
  }
});

test("guarded cancellation refuses a browser created after drain without cancelling it", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  const endpoint = `http://127.0.0.1:${server.port}`;
  const headers = { authorization: `Bearer ${config.controlToken}` };
  let cancelled = 0;
  let finish!: (answer: string) => void;
  try {
    const drained = await fetch(`${endpoint}/admin/drain`, { method: "POST", headers });
    expect(await drained.json()).toMatchObject({ active_browser_turns: 0 });
    chatGptTurnSessions.getOrCreate("drain-race-fixture", () => ({
      mode: "read-only", browser: new Promise(resolve => { finish = resolve; }),
      trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
      cancel: () => { cancelled++; finish("cancelled"); },
    }));
    const refused = await fetch(`${endpoint}/admin/cancel-turns-if-browser-idle`, { method: "POST", headers });
    expect(refused.status).toBe(409);
    expect(cancelled).toBe(0);
    expect(chatGptTurnSessions.activeCount()).toBe(1);
  } finally {
    finish?.("done");
    await chatGptTurnSessions.retireAndWait("drain-race-fixture");
    await server.stop(true);
  }
});
