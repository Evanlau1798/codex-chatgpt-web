const assert = require("node:assert/strict");
const test = require("node:test");

const { ManualTurnController } = require("../electron/manual-turn-controller.cjs");
const { BrowserHost } = require("../electron/browser-host.cjs");

function fixture(Controller = ManualTurnController) {
  const tabs = new Map();
  const clipboard = [];
  const host = {
    turnTabs: tabs,
    createManualTurnTab(traceId, helperPid, conversationKey, systemRevision) {
      const tab = { id: traceId, traceId, helperPid, conversationKey,
        pendingSystemRevision: systemRevision, status: "running" };
      tabs.set(tab.id, tab);
      return tab;
    },
    removeTurnTab(tab) { tabs.delete(tab.id); },
    presentManualTurn() {},
    snapshot() { return { tabs: [...tabs.values()].map(tab => BrowserHost.prototype.tabSnapshot.call(this, tab)) }; },
  };
  return {
    clipboard,
    controller: new Controller({
      clipboard: { writeText: value => clipboard.push(value) },
      host,
      logger: { info() {}, warn() {} },
    }),
    host,
  };
}

test("Zero Risk copies only the prompt and requires Sent before connector start", async () => {
  const { clipboard, controller } = fixture();
  controller.begin("trace-a1", 10, "paste me", undefined, undefined);
  assert.deepEqual(clipboard, ["paste me"]);
  assert.throws(() => controller.started("trace-a1", 10), /not confirmed as sent/);
  controller.confirmSent("trace-a1");
  assert.equal((await controller.waitSent("trace-a1", 10)).status, "sent");
  controller.started("trace-a1", 10);
  assert.equal(controller.end("trace-a1", 10, "completed").cancelledByUser, false);
});

test("Zero Risk rejects ownership changes and prompt rewrites", () => {
  const { controller, clipboard } = fixture();
  controller.begin("trace-a2", 10, "original", undefined, undefined);
  assert.throws(() => controller.begin("trace-a2", 11, "original"), /owned by another process/);
  assert.throws(() => controller.begin("trace-a2", 10, "rewritten"), /different prompt/);
  controller.confirmSent("trace-a2");
  assert.throws(() => controller.begin("trace-a2", 10, "rewritten"), /different prompt/);
  assert.deepEqual(clipboard, ["original"]);
  controller.cancel("trace-a2", 10);
});

test("manual navigation retires completed continuation without invalidating initial setup", () => {
  const { clipboard, controller, host } = fixture();
  const key = "a".repeat(64);
  const first = controller.begin("trace-nav-1", 10, "original context", key);
  const tab = host.turnTabs.get(first.tabId);
  tab.url = "https://chatgpt.com/?temporary-chat=true";
  controller.navigation(tab, "https://chatgpt.com/c/created", false);
  tab.url = "https://chatgpt.com/c/created";
  assert.equal(tab.conversationKey, key);
  controller.confirmSent(tab.id);
  controller.started("trace-nav-1", 10);
  controller.end("trace-nav-1", 10, "completed", true);
  controller.navigation(tab, "https://chatgpt.com/c/another", false);
  assert.equal(tab.conversationKey, undefined);
  const next = controller.begin("trace-nav-2", 10, "full history", key, "delta only");
  assert.equal(next.reused, false);
  assert.deepEqual(clipboard, ["original context", "full history"]);
  controller.cancel("trace-nav-2", 10);
});

test("same-document navigation is safe but document replacement fails a resumed manual turn", async () => {
  const { controller, host } = fixture();
  const key = "b".repeat(64);
  const first = controller.begin("trace-nav-base", 10, "original", key);
  controller.confirmSent(first.tabId);
  controller.started("trace-nav-base", 10);
  controller.end("trace-nav-base", 10, "completed", true);
  const resumed = controller.begin("trace-nav-resume", 10, "full", key, "delta");
  const tab = host.turnTabs.get(resumed.tabId);
  tab.url = "https://chatgpt.com/c/retained";
  controller.navigation(tab, `${tab.url}#answer`, true);
  assert.equal(tab.conversationKey, key);
  const terminal = controller.waitTerminal("trace-nav-resume", 10, 1_000);
  controller.navigation(tab, tab.url, false);
  assert.equal(tab.status, "error");
  assert.equal((await terminal).status, "failed");
  assert.match(tab.message, /full context/);
});

test("the first ChatGPT conversation route created after Sent can be retained", () => {
  const { controller, host } = fixture();
  const first = controller.begin("trace-nav-first", 10, "original", "c".repeat(64));
  const tab = host.turnTabs.get(first.tabId);
  tab.url = "https://chatgpt.com/?temporary-chat=true";
  controller.confirmSent(tab.id);
  controller.navigation(tab, "https://chatgpt.com/c/created", true);
  controller.started("trace-nav-first", 10);
  controller.end("trace-nav-first", 10, "completed", true);
  assert.equal(tab.conversationKey, "c".repeat(64));
  assert.equal(tab.status, "ready");
  tab.url = "https://chatgpt.com/c/created";
  controller.navigation(tab, "https://chatgpt.com/c/another", true);
  assert.equal(tab.conversationKey, undefined);
});

test("a fresh turn never retains navigation outside ChatGPT", () => {
  const { controller, host } = fixture();
  const first = controller.begin("trace-nav-external", 10, "original", "e".repeat(64));
  const tab = host.turnTabs.get(first.tabId);
  tab.url = "https://chatgpt.com/?temporary-chat=true";
  controller.confirmSent(tab.id);
  controller.navigation(tab, "https://example.com/", false);
  assert.equal(tab.conversationKey, undefined);
});

test("duplicate manual start preserves the original deadline and running lease shape", () => {
  const { controller, host, clipboard } = fixture();
  const first = controller.begin("trace-retry", 10, "original");
  const repeated = controller.begin("trace-retry", 10, "original");
  assert.equal(first.reused, false);
  assert.equal(repeated.reused, true);
  assert.equal(repeated.tabId, first.tabId);
  assert.deepEqual(clipboard, ["original"]);
  assert.equal(JSON.stringify(host.snapshot()).includes("original"), false);
  assert.equal(Object.hasOwn(host.snapshot().tabs[0], "prompt"), false);
  assert.equal(Object.hasOwn(host.snapshot().tabs[0], "promptDigest"), false);
  assert.equal(repeated.deadlineAt, first.deadlineAt);
  controller.confirmSent(first.tabId);
  controller.started("trace-retry", 10);
  assert.equal(controller.begin("trace-retry", 10, "original").deadlineAt, null);
  controller.end("trace-retry", 10, "completed");
});

test("selected Copy and Sent affect only their manual turn", async () => {
  const { controller, host, clipboard } = fixture();
  controller.begin("trace-first", 10, "first");
  controller.begin("trace-second", 11, "second");
  host.selectedTabId = "trace-first";
  const sent = controller.waitSent("trace-first", 10);
  controller.copy(host.selectedTabId);
  controller.confirmSent(host.selectedTabId);
  assert.equal((await sent).status, "sent");
  assert.deepEqual(clipboard, ["first", "second", "first"]);
  assert.equal(host.turnTabs.get("trace-first").manualState, "sent");
  assert.equal(host.turnTabs.get("trace-second").manualState, "awaiting-user");
  assert.throws(() => controller.copy("trace-first"), /unavailable/);
  controller.cancel("trace-first", 10);
  controller.cancel("trace-second", 11);
});

test("manual deadline ends at Sent while unconfirmed handoff still expires", async () => {
  const fs = require("node:fs");
  const vm = require("node:vm");
  const { createRequire } = require("node:module");
  const source = require.resolve("../electron/manual-turn-controller.cjs");
  const timers = new Map();
  let now = 1_000;
  const exports = { exports: {} };
  vm.runInNewContext(fs.readFileSync(source, "utf8"), {
    require: createRequire(source), module: exports,
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback, delay) { const timer = { callback, at: now + delay }; timers.set(timer, timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
  });
  const { controller, host } = fixture(exports.exports.ManualTurnController);
  const first = controller.begin("trace-timeout", 10, "prompt");
  assert.equal(Date.parse(first.deadlineAt) - now, 180_000);
  const sent = controller.waitSent("trace-timeout", 10, 240_000);
  const terminal = controller.waitTerminal("trace-timeout", 10, 240_000);
  const deadline = host.turnTabs.get(first.tabId).manualTimer;
  now = deadline.at;
  deadline.callback();
  assert.equal((await sent).status, "timeout");
  assert.equal((await terminal).status, "timeout");
  assert.equal(host.turnTabs.size, 0);
  assert.equal(timers.size, 0);
  assert.throws(() => controller.begin("trace-timeout", 10, "prompt"), { code: "manual_turn_timed_out" });
  const next = controller.begin("trace-started", 10, "prompt");
  controller.confirmSent(next.tabId);
  assert.equal(timers.size, 0);
  assert.equal(host.turnTabs.get(next.tabId).manualDeadlineAt, null);
  assert.equal(host.turnTabs.get(next.tabId).manualState, "sent");
  controller.started("trace-started", 10);
  assert.equal(timers.size, 0);
  assert.equal(host.turnTabs.get(next.tabId).manualDeadlineAt, null);
  controller.end("trace-started", 10, "completed");
});

test("a different owner is rejected before reaping and cannot read the old terminal", async () => {
  const { controller, host, clipboard } = fixture();
  const first = controller.begin("trace-owner", -1, "old prompt");
  assert.throws(() => controller.begin("trace-owner", process.pid, "new prompt"), /owned by another process/);
  assert.equal(host.turnTabs.size, 1);
  assert.deepEqual(clipboard, ["old prompt"]);
  controller.reap(host.turnTabs.get(first.tabId));
  assert.equal(host.turnTabs.size, 0);
  assert.equal((await controller.waitSent("trace-owner", -1)).status, "failed");
  assert.throws(() => controller.waitSent("trace-owner", process.pid), /ownership mismatch/);
});

test("Zero Risk cancellation resolves only the selected turn", async () => {
  const { controller, host } = fixture();
  controller.begin("trace-a3", 10, "one", undefined, undefined);
  controller.begin("trace-a4", 11, "two", undefined, undefined);
  const terminal = controller.waitTerminal("trace-a3", 10, 1_000);
  controller.cancel("trace-a3", 10);
  assert.equal((await terminal).status, "cancelled");
  assert.equal(host.turnTabs.has("trace-a4"), true);
});

test("invalid resume prompts cannot mutate retained ownership or the clipboard", () => {
  const { controller, host, clipboard } = fixture();
  const key = "a".repeat(64);
  const first = controller.begin("trace-full", 10, "full", key);
  controller.confirmSent(first.tabId);
  controller.started("trace-full", 10);
  controller.end("trace-full", 10, "completed", true);
  for (const suffix of ["", 42, "x".repeat(2_000_001)]) {
    assert.throws(() => controller.begin("trace-next", 10, "full", key, suffix), /resume prompt/i);
    assert.equal(host.turnTabs.get(first.tabId).traceId, "trace-full");
    assert.deepEqual(clipboard, ["full"]);
  }
  controller.begin("trace-next", 10, "full", key, "suffix");
  assert.deepEqual(clipboard, ["full", "suffix"]);
  controller.cancel("trace-next", 10);
});

test("a cancelled owner cannot recreate the same trace over its terminal evidence", async () => {
  const { controller, host, clipboard } = fixture();
  controller.begin("trace-cancel", 10, "full");
  controller.cancel("trace-cancel", 10);
  assert.throws(() => controller.begin("trace-cancel", 10, "full"), /already.*cancelled/);
  assert.equal(host.turnTabs.size, 0);
  assert.deepEqual(clipboard, ["full"]);
  assert.deepEqual(await controller.waitSent("trace-cancel", 10), { status: "cancelled" });
});

test("retained TTL starts at successful manual completion, including suffix reuse", () => {
  const { controller, host } = fixture();
  const key = "b".repeat(64);
  const first = controller.begin("trace-ttl", 10, "full", key);
  for (const traceId of ["trace-ttl", "trace-ttl-next"]) {
    if (traceId !== "trace-ttl") controller.begin(traceId, 10, "full", key, "suffix");
    controller.confirmSent(first.tabId);
    controller.started(traceId, 10);
    host.turnTabs.get(first.tabId).lastHeartbeatAt = 1;
    const before = Date.now();
    controller.end(traceId, 10, "completed", true);
    assert.ok(host.turnTabs.get(first.tabId).lastHeartbeatAt >= before);
    assert.equal(host.turnTabs.get(first.tabId).status, "ready");
  }
});

test("Zero Risk refreshes changed system context on the retained tab and commits only after completion", () => {
  const { controller, host, clipboard } = fixture();
  const key = "d".repeat(64);
  const firstRevision = "1".repeat(64);
  const nextRevision = "2".repeat(64);
  const first = controller.begin("trace-refresh-1", 10, "full", key, undefined, false, undefined, firstRevision);
  assert.equal(first.promptMode, "full");
  controller.confirmSent(first.tabId);
  controller.started("trace-refresh-1", 10);
  controller.end("trace-refresh-1", 10, "completed", true);
  const tab = host.turnTabs.get(first.tabId);
  assert.equal(tab.systemRevision, firstRevision);

  const refreshed = controller.begin(
    "trace-refresh-2", 10, "full", key, "delta", false, "refresh", nextRevision,
  );
  assert.equal(refreshed.promptMode, "refresh");
  assert.equal(tab.systemRevision, firstRevision);
  assert.equal(tab.pendingSystemRevision, nextRevision);
  assert.equal(clipboard.at(-1), "refresh");
  controller.confirmSent(first.tabId);
  controller.started("trace-refresh-2", 10);
  controller.end("trace-refresh-2", 10, "completed", true);
  assert.equal(tab.systemRevision, nextRevision);

  const resumed = controller.begin(
    "trace-refresh-3", 10, "full", key, "delta-2", false, "refresh-2", nextRevision,
  );
  assert.equal(resumed.promptMode, "resume");
  assert.equal(clipboard.at(-1), "delta-2");
  controller.cancel("trace-refresh-3", 10);
});

test("clipboard failure preserves retained ownership and permits a later suffix retry", () => {
  const { controller, host, clipboard } = fixture();
  const key = "c".repeat(64);
  const first = controller.begin("trace-original", 10, "full", key);
  controller.confirmSent(first.tabId);
  controller.started("trace-original", 10);
  controller.end("trace-original", 10, "completed", true);
  const tab = host.turnTabs.get(first.tabId);
  const before = { ...tab };
  const writeText = controller.clipboard.writeText;
  controller.clipboard.writeText = () => { throw new Error("clipboard unavailable"); };
  assert.throws(() => controller.begin("trace-resume", 11, "full", key, "suffix"), /clipboard unavailable/);
  assert.deepEqual(tab, before);
  assert.throws(() => controller.end("trace-resume", 11, "failed"), /ownership mismatch/);
  assert.equal(host.turnTabs.get(first.tabId), tab);
  controller.clipboard.writeText = writeText;
  assert.equal(controller.begin("trace-resume", 11, "full", key, "suffix").reused, true);
  assert.deepEqual(clipboard, ["full", "suffix"]);
  controller.cancel("trace-resume", 11);
});

test("clipboard failure on a fresh start leaves no manual surface or timer", () => {
  const { controller, host } = fixture();
  controller.clipboard.writeText = () => { throw new Error("clipboard unavailable"); };
  assert.throws(() => controller.begin("trace-fresh", 10, "full"), /clipboard unavailable/);
  assert.equal(host.turnTabs.size, 0);
});

test("manual completion is idempotent and cannot be downgraded after a lost acknowledgement", () => {
  for (const retain of [true, false]) {
    const { controller, host, clipboard } = fixture();
    const trace = `completion-${retain}`;
    const lease = controller.begin(trace, 10, "private prompt", retain ? "a".repeat(64) : undefined);
    controller.confirmSent(lease.tabId);
    controller.started(trace, 10);
    controller.end(trace, 10, "completed", retain);
    for (const status of ["completed", "failed", "aborted"]) {
      assert.deepEqual(controller.end(trace, 10, status, false), { cancelledByUser: false });
    }
    assert.throws(() => controller.end(trace, 11, "failed"), /ownership mismatch/);
    assert.throws(() => controller.begin(trace, 10, "private prompt"), /already completed/);
    assert.throws(() => controller.begin(trace, 11, "private prompt"), /owned by another process/);
    assert.deepEqual(clipboard, ["private prompt"]);
    assert.equal(host.turnTabs.size, retain ? 1 : 0);
    if (retain) assert.equal(host.turnTabs.get(lease.tabId).manualState, "completed");
  }
});
