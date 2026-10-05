import { expect, spyOn, test } from "bun:test";
import { chromium } from "playwright-core";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as host from "../src/launcher-browser-host";
import * as limits from "../src/adapters/chatgpt-web/limits";
import { prepareChatGptStartupPage } from "../src/adapters/chatgpt-web/startup-page-resource";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptStartupPagePool } from "../src/adapters/chatgpt-web/startup-page-pool";
import * as stages from "../src/adapters/chatgpt-web/browser-stage-lifecycle";

function fixture(onEnd?: (owner: { traceId: string; helperPid: number }) => Promise<void>) {
  const phases: string[] = [];
  const progress: unknown[] = [];
  const surfaceId = "a".repeat(32);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/json/version") return Response.json({ webSocketDebuggerUrl: "ws://127.0.0.1:12345/test" });
    const body = await req.json() as { phase: string; traceId: string; helperPid: number; progress?: unknown }; phases.push(body.phase);
    if (body.phase === "end") await onEnd?.(body);
    if (body.phase === "heartbeat") {
      expect(body.traceId).toBe("transfer-cleanup");
      expect(body.helperPid).toBe(process.pid);
      progress.push(body.progress);
    }
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
  return { path, descriptor, surfaceId, browser, connection: { descriptor, browser, context, page }, phases, progress,
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
  const pool = new ChatGptStartupPagePool<any>();
  const worker: any = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "launcher", browserHostDescriptorPath: f.path },
    startupPages: pool,
  });
  try {
    await pool.prime(worker.startupPageKey({ modelId: "gpt-5.6-sol", reasoning: "high", modelFamily: "5.6",
      capabilities: { localToolsEnabled: true, solAvailable: true } }), "Harness", async () => ({ surfaceId: f.surfaceId,
      pauseHeartbeat() {}, prefix: "Harness", takeConnection: () => { transferred++; return f.connection; },
      release: async () => { if (failure === "old-owner-release") throw new Error("original release failure"); } }));
    await expect(worker.runExclusive({ traceId: "transfer-cleanup", modelId: "gpt-5.6-sol", reasoning: "high",
      modelFamily: "5.6", nativeConnector: true, allowStartupPreparation: true,
      capabilities: { localToolsEnabled: true, solAvailable: true },
      prepare: async () => { throw new Error("original prepare failure"); } }))
      .rejects.toThrow(failure === "old-owner-release" ? "original release failure" : "original prepare failure");
    expect(transferred).toBe(1);
    expect(f.closes).toBe(1);
    expect(f.phases).toEqual(failure === "prompt-prepare" ? ["start", "heartbeat", "end"] : ["start", "end"]);
    expect(f.progress).toEqual(failure === "prompt-prepare" ? [{stage: "preparing", activeToolCalls: 0}] : []);
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

test.each(["live", "transferred"])("lost %s end acknowledgement is reconciled by the same owner without reopening or closing transport twice", async kind => {
  const owners: Array<{ traceId: string; helperPid: number }> = [];
  const { BrowserHost } = require("../launcher/electron/browser-host.cjs");
  const lifecycle = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map(), closedTurnOwners: new Map(), userCancelledTurnOwners: new Map(),
    logger: { info() {}, warn() {} }, syncPowerSaveBlocker() {}, syncViewVisibility() {},
    snapshot: () => ({}), publishState() {}, writeDescriptor() {}, getMaxBrowserTabs: () => 6,
    removeTurnTab(tab: { id: string }) { this.turnTabs.delete(tab.id); },
  });
  let acknowledge!: () => void;
  const withheld = new Promise<void>(resolve => { acknowledge = resolve; });
  const f = fixture(async owner => {
    owners.push({ traceId: owner.traceId, helperPid: owner.helperPid });
    if (owners.length === 1) {
      lifecycle.turnTabs.set("standby", { id: "standby", surfaceId: f.surfaceId, ...owner,
        startupPreparation: true, startupReady: true, bootstrapReady: true, status: "ready",
        interactionMode: "automatic", connectorIdentity: "Codex Native2", connectorBound: true,
        view: { webContents: { isDestroyed: () => false, setBackgroundThrottling() {} } } });
      if (kind === "transferred") await lifecycle.beginTurn("active-work", false, owner.helperPid, true,
        undefined, "Codex Native2", false, undefined, { surfaceId: f.surfaceId });
    }
    await lifecycle.endTurn(owner.traceId, owner.helperPid, "aborted", false);
    if (owners.length === 1) await withheld;
  });
  const connect = spyOn(host, "connectLauncherBrowserHost").mockResolvedValue(f.connection);
  const account = spyOn(limits, "readChatGptUsageAccount").mockResolvedValue({ needsAttention: false } as never);
  const notify = host.notifyLauncherTurn;
  const bounded = spyOn(host, "notifyLauncherTurn").mockImplementation((path, activity, timeout, signal) =>
    notify(path, activity, activity.phase === "end" ? 100 : timeout, signal));
  let prepared: Awaited<ReturnType<typeof prepareChatGptStartupPage>> | undefined;
  try {
    prepared = await prepareChatGptStartupPage({ descriptorPath: f.path, connectorIdentity: "Codex Native2",
      prefix: "Harness", prepare: async () => ({ modelId: "gpt-5.6-sol", effort: "high" } as never) }, new AbortController().signal);
    if (kind === "transferred") expect(prepared.takeConnection?.()).toBe(f.connection);
    await expect(prepared.release()).rejects.toThrow("end timed out after 100ms");
    expect(prepared.isAvailable?.()).toBe(false);
    expect(prepared.takeConnection?.()).toBeUndefined();
    acknowledge();
    await prepared.release();
    await prepared.release();
    expect(owners).toHaveLength(2);
    expect(owners[1]).toEqual(owners[0]);
    if (kind === "transferred") {
      expect(lifecycle.turnTabs.get("standby").traceId).toBe("active-work");
      expect(f.closes).toBe(0);
      await f.browser.close();
    }
    expect(f.closes).toBe(1);
    expect(f.phases).toEqual(["start", "prepared", "end", "end"]);
    expect(host.LAUNCHER_TURN_END_TIMEOUT_MS).toBe(15_000);
  } finally {
    acknowledge();
    await prepared?.release().catch(() => {});
    bounded.mockRestore(); connect.mockRestore(); account.mockRestore(); f.cleanup();
  }
});

test("early lease cleanup remains retryable when aborted preparation never returns a resource", async () => {
  const f = fixture(), pool = new ChatGptStartupPagePool<any>();
  const connect = spyOn(host, "connectLauncherBrowserHost").mockResolvedValue(f.connection);
  let ready!: () => void, finish!: () => void, acknowledged = false;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const notify = host.notifyLauncherTurn;
  const control = spyOn(host, "notifyLauncherTurn").mockImplementation((path, activity, timeout, signal) => {
    if (activity.phase === "end" && !acknowledged) return Promise.reject(new Error("end unacknowledged"));
    return notify(path, activity, timeout, signal);
  });
  try {
    const initial = pool.prime("old", "Harness", (signal, registerCleanup) => prepareChatGptStartupPage({
      descriptorPath: f.path, connectorIdentity: "Codex Native2", prefix: "Harness",
      prepare: async () => { ready(); await pending; signal.throwIfAborted(); return {} as never; },
    }, signal, registerCleanup));
    await started;
    const cancel = pool.cancel(); finish(); await initial;
    await expect(cancel).rejects.toThrow("end unacknowledged");
    let allocated = false;
    await expect(pool.prime("new", "Harness", async () => { allocated = true; return {} as never; }))
      .rejects.toThrow("end unacknowledged");
    expect(allocated).toBe(false); expect(f.closes).toBe(1);
    acknowledged = true; await pool.cancel();
    expect(f.phases).toEqual(["start", "end"]); expect(f.closes).toBe(1);
  } finally { acknowledged = true; finish?.(); await pool.cancel(); control.mockRestore(); connect.mockRestore(); f.cleanup(); }
});

test("a rejected warm acquisition retains failed cleanup until the exact owner acknowledges", async () => {
  const f = fixture(), pool = new ChatGptStartupPagePool<any>();
  const prior = process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS;
  process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS = "1";
  let acknowledged = false, releases = 0, acquisitions = 0;
  const resource = { surfaceId: f.surfaceId, prefix: "Harness", pauseHeartbeat() {}, release: async () => {
    releases++; if (!acknowledged) throw new Error("standby end unacknowledged");
  } };
  const worker: any = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "launcher", browserHostDescriptorPath: f.path }, startupPages: pool,
  });
  const turn = { traceId: "transfer-cleanup", modelId: "gpt-5.6-sol", reasoning: "high", modelFamily: "5.6",
    nativeConnector: true, allowStartupPreparation: true, capabilities: { localToolsEnabled: true, solAvailable: true } };
  const control = spyOn(host, "notifyLauncherTurn").mockImplementation(async () => {
    acquisitions++; throw new Error("acquisition failed");
  });
  try {
    await pool.prime(worker.startupPageKey(turn), "Harness", async () => resource);
    const failed = await worker.runExclusive(turn).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(AggregateError);
    expect(failed.errors.map((error: Error) => error.message)).toEqual(["acquisition failed", "standby end unacknowledged"]);
    await expect(worker.runExclusive(turn)).rejects.toThrow("standby end unacknowledged");
    expect(acquisitions).toBe(1); expect(releases).toBe(2);
    acknowledged = true;
    await expect(worker.runExclusive(turn)).rejects.toThrow("acquisition failed");
    expect(releases).toBe(3); expect(acquisitions).toBe(2);
  } finally {
    acknowledged = true; await pool.cancel(); control.mockRestore(); f.cleanup();
    if (prior === undefined) delete process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS;
    else process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS = prior;
  }
});

test.each(["viewport", "selection"])("transferred transport closes exactly once across inner and outer %s failure", async failure => {
  const f = fixture(), prior = process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS;
  process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS = "1";
  const viewport = spyOn(stages, "waitForOperationalChatGptViewport").mockRejectedValue(new Error("viewport failed"));
  const connect = spyOn(chromium, "connectOverCDP").mockResolvedValue(f.browser);
  if (failure === "selection") {
    const original = f.connection.context.newCDPSession;
    let sessions = 0;
    f.connection.context.newCDPSession = async () => {
      if (++sessions > 1) throw new Error("selection failed");
      return original();
    };
  }
  const pool = new ChatGptStartupPagePool<any>();
  let promptReleased = 0;
  const worker: any = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "launcher", browserHostDescriptorPath: f.path }, startupPages: pool,
    compactionBoundaryRetentions: new Set(),
    runStage: async (_trace: string, _stage: string, ms: number, action: any) => action(new AbortController().signal, () => ms),
  });
  const turn = { traceId: "transfer-cleanup", modelId: "gpt-5.6-sol", reasoning: "high", modelFamily: "5.6",
    nativeConnector: true, allowStartupPreparation: true, capabilities: { localToolsEnabled: true, solAvailable: true },
    prepare: async () => ({ text: "hello", images: [], release: () => { promptReleased++; } }) };
  try {
    await pool.prime(worker.startupPageKey(turn), "Harness", async () => ({ surfaceId: f.surfaceId, prefix: "Harness",
      pauseHeartbeat() {}, release: async () => {}, takeConnection: () => f.connection }));
    await expect(worker.runExclusive(turn)).rejects.toThrow(`${failure} failed`);
    expect(f.closes).toBe(1); expect(promptReleased).toBe(1);
    expect(f.phases).toEqual(["start", "heartbeat", "end"]);
  } finally {
    await pool.cancel(); viewport.mockRestore(); connect.mockRestore(); f.cleanup();
    if (prior === undefined) delete process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS;
    else process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS = prior;
  }
});

test.each(["aborted", "failed", "completed"])("user close retains one end retry when %s settlement beats cancellation acknowledgement", async status => {
  const { BrowserHost } = require("../launcher/electron/browser-host.cjs");
  let acknowledge!: () => void, started!: () => void, closes = 0;
  const pending = new Promise<void>(resolve => { acknowledge = resolve; });
  const cancelling = new Promise<void>(resolve => { started = resolve; });
  const tab = { id: "closing", traceId: "closing-owner", helperPid: process.pid, status: "running",
    interactionMode: "automatic", connectorIdentity: "Codex Native2", connectorBound: true,
    view: { webContents: { isDestroyed: () => false, setBackgroundThrottling() {}, close() { closes++; } } } };
  const other = { ...tab, id: "other", traceId: "unrelated-owner" };
  const lifecycle = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab], [other.id, other]]), closedTurnOwners: new Map(), userCancelledTurnOwners: new Map(),
    logger: { info() {} }, syncPowerSaveBlocker() {}, syncViewVisibility() {}, snapshot: () => ({}),
    publishState() {}, writeDescriptor() {}, window: { contentView: { removeChildView() {} } },
    cancelTurn: async () => { started(); await pending; },
  });
  const closing = lifecycle.closeTab(tab.id);
  try {
    await cancelling;
    expect(lifecycle.turnTabs.get(tab.id)).toBe(tab);
    expect(await lifecycle.endTurn(tab.traceId, tab.helperPid, status, false, undefined, status === "completed", true))
      .toEqual({ cancelledByUser: true }); // Host handled the original end; its response is considered lost.
    expect(lifecycle.turnTabs.has(tab.id)).toBe(false);
    expect(tab.status).toBe("aborted");
    acknowledge(); await closing;
    await expect(lifecycle.endTurn(tab.traceId, process.pid + 1, "aborted", false)).rejects.toThrow("ownership mismatch");
    expect(await lifecycle.endTurn(tab.traceId, tab.helperPid, "aborted", false)).toEqual({ cancelledByUser: true });
    await expect(lifecycle.endTurn(tab.traceId, tab.helperPid, "aborted", false)).rejects.toThrow("ownership mismatch");
    expect(lifecycle.turnTabs.get(other.id)).toBe(other);
    expect(closes).toBe(1);
  } finally { acknowledge(); await closing; }
});
