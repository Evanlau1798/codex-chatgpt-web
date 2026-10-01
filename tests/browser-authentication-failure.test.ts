import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptStartupPagePool } from "../src/adapters/chatgpt-web/startup-page-pool";
import { chatGptCompletionEvidenceError, chatGptSessionFailureDisposition } from "../src/adapters/chatgpt-web/adapter-error";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

const require = createRequire(import.meta.url);
const source = require.resolve("../launcher/electron/browser-host.cjs");
const hostRequire = createRequire(source);
const hostModule = { exports: {} as any };
runInNewContext(readFileSync(source, "utf8"), {
  require: (id: string) => id === "electron" ? {} : hostRequire(id),
  module: hostModule, exports: hostModule.exports, Buffer, URL, process,
});
const { BrowserHost } = hostModule.exports;
const { BrowserControlServer } = require("../launcher/electron/control-server.cjs");

test("accepted work prepares a standby before completion, while compact preserves it for the handoff successor", async () => {
  const f = await fixture();
  const previous = process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS;
  process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS = "1";
  let primes = 0, releases = 0;
  const turn: any = { traceId: f.tab.traceId, modelId: "gpt-5.6-sol", modelFamily: "5.6", reasoning: "high",
    nativeConnector: true, allowStartupPreparation: true, capabilities: { localToolsEnabled: true, solAvailable: true },
    prepare: async () => ({ text: "harness", images: [] }), onSubmitted() {} };
  f.worker.primeStartupPage = async () => { primes++; };
  f.worker.runBrowserTurn = async (observed: any) => {
    await observed.prepare();
    await observed.onSubmitted();
    expect(primes).toBe(1); // Actual browser work has not completed yet.
    return "answer";
  };
  try {
    await f.worker.runExclusive(turn);
    const key = f.worker.startupPageKey(turn);
    await f.worker.startupPages.prime(key, "prefix", async () => ({ surfaceId: "b".repeat(32), prefix: "prefix",
      pauseHeartbeat() {}, async release() { releases++; } }));
    f.tab.traceId = "compact_trace";
    f.host.turnTabs.set(f.tab.id, f.tab);
    f.worker.runBrowserTurn = async () => "structured handoff";
    await f.worker.runExclusive({ ...turn, traceId: f.tab.traceId, compaction: true });
    expect(releases).toBe(0);
    f.tab.traceId = "successor_trace";
    f.host.turnTabs.set(f.tab.id, f.tab);
    f.host.beginTurn = async (...args: any[]) => {
      expect(args[8].surfaceId).toBe("b".repeat(32));
      return { surfaceId: args[8].surfaceId, reused: false, startupPrepared: true };
    };
    f.worker.runBrowserTurn = async (_turn: any, _surface: string, _previous: unknown,
      reused: boolean, _usage: boolean, startup: any) => {
      expect(reused).toBe(false);
      expect(startup.surfaceId).toBe("b".repeat(32));
      return "handoff successor";
    };
    await f.worker.runExclusive({ ...turn, traceId: f.tab.traceId });
    expect(releases).toBe(1);
    expect(f.worker.startupPages.take(key)).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS;
    else process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS = previous;
    await f.worker.startupPages.cancel();
    await f.close();
  }
});

// Real launcher navigation binding, end ownership, control HTTP and worker finally;
// only the Electron page and its navigation result are substituted.
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "auth-turn-"));
  const logs: string[] = [];
  const logger = Object.fromEntries(["info", "warn", "error", "debug"].map(name =>
    [name, (event: string, detail: unknown) => logs.push(JSON.stringify({ event, detail }))]));
  const contents: any = new EventEmitter();
  contents.setWindowOpenHandler = () => {};
  contents.isDestroyed = () => false;
  contents.setBackgroundThrottling = () => {};
  const tab: any = { id: "tab", traceId: "auth_test_trace", helperPid: process.pid,
    interactionMode: "automatic", status: "running", view: { webContents: contents } };
  let starts = 0;
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    logger, turnTabs: new Map([[tab.id, tab]]), closedTurnOwners: new Map(), userCancelledTurnOwners: new Map(),
    syncPowerSaveBlocker() {}, syncViewVisibility() {}, publishState() {}, snapshot() { return {}; },
    setState(next: Record<string, unknown>) { Object.assign(host.state, next); },
    state: { authenticated: true, status: "running" }, reauthenticationRequired: false, authenticationRevision: 0,
    writeDescriptor() {}, hide() {},
    beginTurn: async () => { starts++; return { surfaceId: "a".repeat(32), reused: false }; },
    removeTurnTab: () => { host.turnTabs.delete(tab.id); },
  });
  host.bindTurnContents(tab);
  const server = new BrowserControlServer({ logger, getBrowserHost: () => host,
    getPreferences: () => ({ experimentalPreparedWebSession: true }) });
  await server.start();
  const descriptor = join(root, "launcher.json");
  writeFileSync(descriptor, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production", pid: process.pid, endpoint: server.descriptor().endpoint, control: server.descriptor(),
    helper: { executable: process.execPath, script: import.meta.path },
    partition: "persist:codex-web-gpt-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "a".repeat(32), surfaceTargets: { ["a".repeat(32)]: "target" }, createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  const worker: any = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    startupPages: new ChatGptStartupPagePool(),
    config: { browserHost: "launcher", browserHostDescriptorPath: descriptor, appName: "Codex Native2" },
  });
  return { tab, host, logs, worker, contents, starts: () => starts,
    close: async () => { await server.close(); rmSync(root, { recursive: true, force: true }); } };
}

for (const event of ["will-navigate", "will-redirect"]) {
  test(`${event} provider authentication failure survives cleanup as nonretryable owned failure`, async () => {
    const f = await fixture();
    let prevented = 0;
    f.worker.runBrowserTurn = async () => {
      f.contents.emit(event, { preventDefault() { prevented++; } },
        "https://accounts.google.com/o/oauth2/v2/auth?secret=do-not-log");
      throw new Error("page.goto: net::ERR_ABORTED");
    };
    try {
      const error = await f.worker.runExclusive({ traceId: f.tab.traceId,
        modelId: "gpt-5.6-sol", reasoning: "high", onTextDelta() {},
        capabilities: { localToolsEnabled: true, solAvailable: true, proAvailable: false },
      }).catch((error: unknown) => error);
      expect(error).toMatchObject({ code: "chatgpt_sign_in_required", status: 401,
        errorType: "authentication_error", retryable: false });
      expect(chatGptSessionFailureDisposition(error)).toBe("replay");
      expect(f.starts()).toBe(1);
      expect(prevented).toBe(1);
      expect(f.host.turnTabs.size).toBe(0);
      expect(f.logs.join("\n")).not.toContain("do-not-log");
    } finally { await f.close(); }
  });
}

test("authentication navigation does not bypass helper ownership or change manual navigation", async () => {
  const f = await fixture();
  try {
    let prevented = 0;
    f.tab.interactionMode = "manual";
    f.contents.emit("will-redirect", { preventDefault() { prevented++; } }, "https://chatgpt.com/auth/login");
    expect(prevented).toBe(0);
    expect(f.tab.authenticationRequired).toBeUndefined();
    f.tab.interactionMode = "automatic";
    f.contents.emit("will-redirect", { preventDefault() { prevented++; } }, "https://chatgpt.com/auth/login");
    expect(prevented).toBe(0);
    expect(f.tab.authenticationRequired).toBeUndefined();
    await expect(f.host.endTurn(f.tab.traceId, process.pid + 1, "failed", false)).rejects.toThrow("ownership mismatch");
    expect(f.host.turnTabs.size).toBe(1);
  } finally { await f.close(); }
});

for (const cancelled of [false, true]) {
  test(`release preserves ${cancelled ? "user cancellation" : "unrelated navigation errors"}`, async () => {
    const f = await fixture();
    const original = new Error("unrelated navigation failure");
    f.worker.runBrowserTurn = async () => {
      if (cancelled) {
        f.tab.authenticationRequired = true;
        f.host.userCancelledTurnOwners.set(f.tab.traceId, process.pid);
      }
      throw original;
    };
    try {
      const error = await f.worker.runExclusive({ traceId: f.tab.traceId,
        modelId: "gpt-5.6-sol", reasoning: "high", capabilities: { localToolsEnabled: false, solAvailable: true },
      }).catch((error: unknown) => error);
      if (cancelled) expect(error).toMatchObject({ code: "client_cancelled", retryable: false });
      else expect(error).toBe(original);
      expect(f.host.turnTabs.size).toBe(0);
    } finally { await f.close(); }
  });
}

test("an authentication-required tab cannot be retained as a successful conversation", async () => {
  const f = await fixture();
  try {
    f.tab.authenticationRequired = true;
    const result = await f.host.endTurn(f.tab.traceId, process.pid, "completed", false, undefined, true, true);
    expect(result).toMatchObject({ authenticationRequired: true, cancelledByUser: false });
    expect(f.tab.status).toBe("error");
    expect(f.host.turnTabs.size).toBe(0);
  } finally { await f.close(); }
});

test("an armed compact boundary retains the launcher conversation when final evidence is intentionally absent", async () => {
  const f = await fixture();
  const previousHelperProcess = process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS;
  process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS = "1";
  f.worker.activeRuns = new Map([[f.tab.traceId, new Promise<string>(() => {})]]);
  f.worker.compactionBoundaryRetentions = new Set();
  f.worker.finalizingRuns = new Set();
  f.worker.runBrowserTurn = async () => {
    throw chatGptCompletionEvidenceError(
      "ChatGPT stopped after native tool work without a final answer or usable completion evidence",
      false,
    );
  };
  try {
    expect(await f.worker.armCompactionBoundaryRetention(f.tab.traceId)).toBeTrue();
    const error = await f.worker.runExclusive({
      traceId: f.tab.traceId,
      modelId: "gpt-5.6-sol",
      reasoning: "high",
      retainConversation: true,
      nativeConnector: true,
      capabilities: { localToolsEnabled: true, solAvailable: true, proAvailable: false },
    }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "chatgpt_completion_evidence_missing", retryable: true });
    expect(f.host.turnTabs.size).toBe(1);
    expect(f.tab.status).toBe("ready");
    expect(f.logs.join("\n")).toContain("browser.tab_retained");
    expect(f.logs.join("\n")).not.toContain("browser.tab_released");
  } finally {
    if (previousHelperProcess === undefined) delete process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS;
    else process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS = previousHelperProcess;
    await f.close();
  }
});

test("native cancellation wins over an authentication redirect observed during cleanup", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const aborted = new DOMException("native cancellation", "AbortError");
  f.worker.runBrowserTurn = async () => {
    f.tab.authenticationRequired = true;
    controller.abort(aborted);
    throw aborted;
  };
  try {
    await expect(f.worker.runExclusive({ traceId: f.tab.traceId, abortSignal: controller.signal,
      modelId: "gpt-5.6-sol", reasoning: "high", capabilities: { localToolsEnabled: false, solAvailable: true },
    })).rejects.toBe(aborted);
    expect(f.host.turnTabs.size).toBe(0);
  } finally { await f.close(); }
});
