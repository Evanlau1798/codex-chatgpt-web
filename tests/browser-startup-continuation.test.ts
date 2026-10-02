import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CHATGPT_ASSISTANT_TURN_SELECTOR, CHATGPT_USER_TURN_SELECTOR } from "../src/chatgpt-session";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptStartupPagePool } from "../src/adapters/chatgpt-web/startup-page-pool";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { chatGptSubmissionEvidence } from "../src/adapters/chatgpt-web/response-turn-boundary";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

function historyPage(keys: string[]) {
  const { createWindow } = require("@mixmark-io/domino");
  const document = createWindow(keys.map(key => `<section data-turn-key="${key}"><h4 data-conversation-role="assistant"></h4></section>`).join("" )).document;
  const groups = [...document.querySelectorAll("[data-turn-key]")];
  const page: any = {
    url: () => "https://chatgpt.com/c/owned-conversation",
    locator(selector: string) {
      if (![CHATGPT_ASSISTANT_TURN_SELECTOR, CHATGPT_USER_TURN_SELECTOR, "[data-turn-id-container], [data-turn-key]"].includes(selector)) throw new Error("Unexpected selector");
      return { page: () => page, evaluateAll: async (callback: any, name?: string) => callback(groups, name) };
    },
  };
  return page;
}

test("pre-Send history refresh keeps remounted history out of the new-submission delta", async () => {
  const worker: any = Object.create(ChatGptBrowserWorker.prototype);
  const original = await worker.captureSubmissionBaseline(historyPage(["old"]), "exact prompt");
  const refreshed = await worker.captureSubmissionBaseline(historyPage(["history", "old"]), "exact prompt", original);
  expect(refreshed.initialTurnIdentities).toContain("group:user:history");
  expect(chatGptSubmissionEvidence({ initialUserTurnCount: 2, userTurnCount: 3,
    initialAssistantTurnCount: 2, assistantTurnCount: 2, initialTurnIdentities: refreshed.initialTurnIdentities,
    userIdentities: ["group:user:history", "group:user:old", "group:user:new"],
    responseIdentities: ["group:assistant:history", "group:assistant:old"], generationRunning: true })).toBe("user_turn");
  expect(() => chatGptSubmissionEvidence({ initialUserTurnCount: 2, userTurnCount: 4,
    initialAssistantTurnCount: 2, assistantTurnCount: 2, initialTurnIdentities: refreshed.initialTurnIdentities,
    userIdentities: ["group:user:history", "group:user:old", "group:user:new", "group:user:duplicate"],
    responseIdentities: [], generationRunning: true })).toThrow("2 new conversation turns");
});

test.each([
  [["old"], ["old", "unexpected"]],
  [["old"], ["replacement"]],
  [["one", "two"], ["two", "one"]],
  [[], ["unexpected"]],
])("pre-Send refresh rejects new trailing turns, replaced anchors and reordered history (%j)", async (before, after) => {
  const worker: any = Object.create(ChatGptBrowserWorker.prototype);
  const original = await worker.captureSubmissionBaseline(historyPage(before), "exact prompt");
  await expect(worker.captureSubmissionBaseline(historyPage(after), "exact prompt", original))
    .rejects.toThrow("history changed before Send");
});

test("pre-Send refresh permits older history virtualization without losing its last anchor", async () => {
  const worker: any = Object.create(ChatGptBrowserWorker.prototype);
  const original = await worker.captureSubmissionBaseline(historyPage(["older", "old"]), "exact prompt");
  const refreshed = await worker.captureSubmissionBaseline(historyPage(["old"]), "exact prompt", original);
  expect(refreshed.initialTurnIdentities).toEqual(["group:user:old", "group:assistant:old"]);
});

test("pre-Send refresh refuses transferring the baseline to another browser conversation", async () => {
  const worker: any = Object.create(ChatGptBrowserWorker.prototype);
  const original = await worker.captureSubmissionBaseline(historyPage(["old"]), "exact prompt");
  const other = historyPage(["old"]);
  other.url = () => "https://chatgpt.com/c/other-conversation";
  await expect(worker.captureSubmissionBaseline(other, "exact prompt", original)).rejects.toThrow("browser surface changed");
});

test("pre-Send baseline refuses a URL change between snapshot validation and return", async () => {
  const worker: any = Object.create(ChatGptBrowserWorker.prototype);
  const original = await worker.captureSubmissionBaseline(historyPage(["old"]), "exact prompt");
  const changing = historyPage(["old"]);
  let reads = 0;
  changing.url = () => ++reads === 1 ? original.initialPageUrl : "https://chatgpt.com/c/foreign";
  await expect(worker.captureSubmissionBaseline(changing, "exact prompt", original)).rejects.toThrow("browser surface changed");
});

async function refillFixture(error: Error, endFailure = false) {
  const phases: string[] = [];
  const surfaceId = "s".repeat(32);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = await req.json() as { phase: string }; phases.push(body.phase);
    if (body.phase === "end" && endFailure) return Response.json({ error: "release unacknowledged" }, { status: 500 });
    return Response.json(body.phase === "start" ? { surfaceId, reused: true, connectorBound: true, startupAllowed: true }
      : { cancelledByUser: false, authenticationRequired: false });
  } });
  const root = mkdtempSync(join(tmpdir(), "continuation-refill-"));
  const descriptor = join(root, "host.json");
  writeFileSync(descriptor, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production",
    pid: process.pid, endpoint: `http://127.0.0.1:${server.port}`,
    control: { endpoint: `http://127.0.0.1:${server.port}`, token: "offline-fixture-token-0123456789abcdefghijklmnop" },
    helper: { executable: process.execPath, script: import.meta.path }, partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL, surfaceId, surfaceTargets: { [surfaceId]: "owned-target" }, createdAt: new Date().toISOString() }), { mode: 0o600 });
  const previous = process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS;
  process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS = "1";
  const pool = new ChatGptStartupPagePool<any>();
  let released = 0, refill = 0;
  try {
    await pool.maintain("nonmatching-key", "harness", async () => ({ surfaceId, prefix: "harness",
      pauseHeartbeat() {}, release: async () => { released++; } }));
    const worker: any = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      config: { browserHost: "launcher", browserHostDescriptorPath: descriptor, appName: "Codex Native2" },
      startupPages: pool, compactionBoundaryRetentions: new Set(),
      primeStartupPage: async () => { refill++; },
      runBrowserTurn: async (turn: any) => { await turn.prepare(); throw error; },
    });
    let actual: unknown;
    try { await worker.runExclusive({ traceId: "offline-continuation", modelId: "gpt-5.6-sol", reasoning: "high",
      modelFamily: "5.6", nativeConnector: true, allowStartupPreparation: true,
      capabilities: { localToolsEnabled: true, solAvailable: true, proAvailable: true },
      prepare: async () => ({ text: "offline prepared prompt", images: [], release() {} }) }); }
    catch (caught) { actual = caught; }
    expect(actual).toBe(error);
    expect(phases).toEqual(["start", "end"]);
    expect(released).toBe(1);
    return refill;
  } finally {
    await pool.cancel(); server.stop(true);
    rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS;
    else process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS = previous;
  }
}

test("settled submission failure replenishes standby without resending the failed prompt", async () => {
  expect(await refillFixture(new Error("ChatGPT exposed 2 new conversation turns for one submitted message"))).toBe(1);
});

test.each([
  [401, "chatgpt_session_expired"], [429, "chatgpt_rate_limited"], [403, "chatgpt_authentication_blocked"],
])("authentication and account-limit failures never replenish standby (%i)", async (status, code) => {
  expect(await refillFixture(new ChatGptWebAdapterError("account blocked", {
    status, code, errorType: "server_error", retryable: false }))).toBe(0);
});

test("user abort and unacknowledged ownership release never replenish standby", async () => {
  expect(await refillFixture(new DOMException("cancelled", "AbortError"))).toBe(0);
  expect(await refillFixture(new Error("surface failed"), true)).toBe(0);
});
