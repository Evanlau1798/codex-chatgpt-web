import { expect, spyOn, test } from "bun:test";
import { chromium } from "playwright-core";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as host from "../src/launcher-browser-host";
import * as limits from "../src/adapters/chatgpt-web/limits";
import { prepareChatGptStartupPage } from "../src/adapters/chatgpt-web/startup-page-resource";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

function fixture() {
  const phases: string[] = [];
  const surfaceId = "a".repeat(32);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/json/version") return Response.json({ webSocketDebuggerUrl: "ws://127.0.0.1:12345/test" });
    const body = await req.json() as { phase: string }; phases.push(body.phase);
    return Response.json(body.phase === "start" ? { surfaceId, reused: false, connectorBound: false, startupPrepared: !(body as any).startupPreparation }
      : body.phase === "prepared" ? { prepared: true } : { cancelledByUser: false, authenticationRequired: false });
  } });
  const root = mkdtempSync(join(tmpdir(), "startup-transfer-")), path = join(root, "host.json");
  const descriptor: host.LauncherBrowserHostDescriptor = { version: 3, kind: host.LAUNCHER_BROWSER_HOST_KIND,
    profile: "production", pid: process.pid, endpoint: `http://127.0.0.1:${server.port}`,
    control: { endpoint: `http://127.0.0.1:${server.port}`, token: "launcher-control-token-0123456789abcdefghijklmnop" },
    helper: { executable: process.execPath, script: import.meta.path }, partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: host.LAUNCHER_BROWSER_IDLE_URL, surfaceId, surfaceTargets: { [surfaceId]: "owned-target" }, createdAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(descriptor), { mode: 0o600 });
  let closes = 0;
  const page: any = {};
  const context: any = { pages: () => [page], newCDPSession: async () => ({
    send: async () => ({ targetInfo: { targetId: "owned-target" } }), detach: async () => {} }) };
  const browser: any = { isConnected: () => true, contexts: () => [context], close: async () => { closes++; } };
  return { path, descriptor, surfaceId, browser, connection: { descriptor, browser, context, page }, phases,
    get closes() { return closes; }, cleanup: () => { server.stop(true); rmSync(root, { recursive: true, force: true }); } };
}

test("prepared connection is transferred once and its old owner cannot close it", async () => {
  const f = fixture();
  const connect = spyOn(host, "connectLauncherBrowserHost").mockResolvedValue(f.connection);
  const account = spyOn(limits, "readChatGptUsageAccount").mockResolvedValue({ accountKey: "test", planType: "pro", personal: true, needsAttention: false } as never);
  let prepared: any;
  try {
    prepared = await prepareChatGptStartupPage({ descriptorPath: f.path, connectorIdentity: "Codex Native2",
      prefix: "Harness", prepare: async () => ({ modelId: "gpt-5.6-sol", effort: "high" } as never) }, new AbortController().signal);
    expect(prepared.takeConnection?.()).toBe(f.connection);
    expect(prepared.takeConnection?.()).toBeUndefined();
    await prepared.release();
    expect(f.closes).toBe(0);
    expect(f.phases).toEqual(["start", "prepared", "end"]);
    await f.browser.close();
    expect(f.closes).toBe(1);
  } finally { await prepared?.release(); connect.mockRestore(); account.mockRestore(); f.cleanup(); }
});

test("reuse still selects the registered native target without reconnecting CDP", async () => {
  const f = fixture(), connect = spyOn(chromium, "connectOverCDP").mockResolvedValue(f.browser);
  try {
    const result = await (host.connectLauncherBrowserHost as any)(f.path, 1000, f.surfaceId, undefined, f.connection);
    expect(result.page).toBe(f.connection.page);
    expect(connect).not.toHaveBeenCalled();
  } finally { connect.mockRestore(); f.cleanup(); }
});

test.each(["pid", "endpoint", "profile", "target"])("reuse rejects changed %s identity", async changed => {
  const f = fixture(), connect = spyOn(chromium, "connectOverCDP").mockResolvedValue(f.browser);
  const old = { ...f.connection, descriptor: { ...f.descriptor, surfaceTargets: { ...f.descriptor.surfaceTargets } } };
  if (changed === "pid") old.descriptor.pid = -1;
  if (changed === "endpoint") old.descriptor.endpoint = "http://127.0.0.1:1";
  if (changed === "profile") old.descriptor.profile = "development";
  if (changed === "target") old.descriptor.surfaceTargets[f.surfaceId] = "foreign-target";
  try {
    await expect((host.connectLauncherBrowserHost as any)(f.path, 1000, f.surfaceId, undefined, old)).rejects.toThrow("prepared browser identity changed");
    expect(connect).not.toHaveBeenCalled();
  } finally { connect.mockRestore(); f.cleanup(); }
});

test.each(["old-owner-release", "prompt-prepare"])("claimed transport is cleaned when %s fails before browser work", async failure => {
  const f = fixture(), prior = process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS;
  process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS = "1";
  let transferred = 0;
  const worker: any = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "launcher", browserHostDescriptorPath: f.path },
    startupPages: { take: () => ({ surfaceId: f.surfaceId,
      takeConnection: () => { transferred++; return f.connection; },
      release: async () => { if (failure === "old-owner-release") throw new Error("original release failure"); } }) },
  });
  try {
    await expect(worker.runExclusive({ traceId: "transfer-cleanup", modelId: "gpt-5.6-sol", reasoning: "high",
      modelFamily: "5.6", nativeConnector: true, allowStartupPreparation: true,
      capabilities: { localToolsEnabled: true, solAvailable: true },
      prepare: async () => { throw new Error("original prepare failure"); } }))
      .rejects.toThrow(failure === "old-owner-release" ? "original release failure" : "original prepare failure");
    expect(transferred).toBe(1);
    expect(f.closes).toBe(1);
    expect(f.phases).toEqual(["start", "end"]);
  } finally {
    if (prior === undefined) delete process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS;
    else process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS = prior;
    f.cleanup();
  }
});

test("unclaimed prepared transport keeps the original release responsibility", async () => {
  const f = fixture(), connect = spyOn(host, "connectLauncherBrowserHost").mockResolvedValue(f.connection);
  const account = spyOn(limits, "readChatGptUsageAccount").mockResolvedValue({ needsAttention: false } as never);
  try {
    const prepared = await prepareChatGptStartupPage({ descriptorPath: f.path, connectorIdentity: "Codex Native2",
      prefix: "Harness", prepare: async () => ({ modelId: "gpt-5.6-sol", effort: "high" } as never) }, new AbortController().signal);
    await prepared.release();
    await prepared.release();
    expect(f.closes).toBe(1);
    expect(prepared.takeConnection?.()).toBeUndefined();
    expect(f.phases).toEqual(["start", "prepared", "end"]);
  } finally { connect.mockRestore(); account.mockRestore(); f.cleanup(); }
});
