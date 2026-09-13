import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptSessionFailureDisposition } from "../src/adapters/chatgpt-web/adapter-error";
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
    writeDescriptor() {}, hide() {},
    beginTurn: async () => { starts++; return { surfaceId: "a".repeat(32), reused: false }; },
    removeTurnTab: () => { host.turnTabs.delete(tab.id); },
  });
  host.bindTurnContents(tab);
  const server = new BrowserControlServer({ logger, getBrowserHost: () => host, getPreferences: () => ({}) });
  await server.start();
  const descriptor = join(root, "launcher.json");
  writeFileSync(descriptor, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production", pid: process.pid, endpoint: server.descriptor().endpoint, control: server.descriptor(),
    helper: { executable: process.execPath, script: import.meta.path },
    partition: "persist:codex-web-gpt-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "a".repeat(32), surfaceTargets: { ["a".repeat(32)]: "target" }, createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  const worker: any = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "launcher", browserHostDescriptorPath: descriptor, appName: "Codex Native2" },
  });
  return { tab, host, logs, worker, contents, starts: () => starts,
    close: async () => { await server.close(); rmSync(root, { recursive: true, force: true }); } };
}

for (const event of ["will-navigate", "will-redirect"]) {
  test(`${event} authentication failure survives cleanup as nonretryable owned failure`, async () => {
    const f = await fixture();
    let prevented = 0;
    f.worker.runBrowserTurn = async () => {
      f.contents.emit(event, { preventDefault() { prevented++; } },
        "https://chatgpt.com/auth/login?secret=do-not-log");
      throw new Error("page.goto: net::ERR_ABORTED");
    };
    try {
      const error = await f.worker.runExclusive({ traceId: f.tab.traceId,
        modelId: "gpt-5.6-sol", reasoning: "high", onTextDelta() {},
        capabilities: { localToolsEnabled: true, solAvailable: true, proAvailable: false },
      }).catch((error: unknown) => error);
      expect(error).toMatchObject({ code: "chatgpt_session_expired", status: 401,
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
    expect(f.tab.authenticationBlocked).toBeUndefined();
    f.tab.interactionMode = "automatic";
    f.contents.emit("will-redirect", { preventDefault() { prevented++; } }, "https://chatgpt.com/auth/login");
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
        f.tab.authenticationBlocked = true;
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

test("an authentication-blocked tab cannot be retained as a successful conversation", async () => {
  const f = await fixture();
  try {
    f.tab.authenticationBlocked = true;
    const result = await f.host.endTurn(f.tab.traceId, process.pid, "completed", false, undefined, true, true);
    expect(result).toMatchObject({ authenticationBlocked: true, cancelledByUser: false });
    expect(f.tab.status).toBe("error");
    expect(f.host.turnTabs.size).toBe(0);
  } finally { await f.close(); }
});

test("native cancellation wins over an authentication redirect observed during cleanup", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const aborted = new DOMException("native cancellation", "AbortError");
  f.worker.runBrowserTurn = async () => {
    f.tab.authenticationBlocked = true;
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
