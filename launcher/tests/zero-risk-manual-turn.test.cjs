const assert = require("node:assert/strict");
const test = require("node:test");

const { ManualTurnController } = require("../electron/manual-turn-controller.cjs");

function fixture() {
  const tabs = new Map();
  const clipboard = [];
  const host = {
    turnTabs: tabs,
    createManualTurnTab(traceId, helperPid, conversationKey, prompt) {
      const tab = { id: traceId, traceId, helperPid, conversationKey, prompt, status: "running" };
      tabs.set(tab.id, tab);
      return tab;
    },
    removeTurnTab(tab) { tabs.delete(tab.id); },
    presentManualTurn() {},
    snapshot() { return { tabs: [...tabs.values()] }; },
  };
  return {
    clipboard,
    controller: new ManualTurnController({
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
  const { controller } = fixture();
  controller.begin("trace-a2", 10, "original", undefined, undefined);
  assert.throws(() => controller.begin("trace-a2", 11, "original"), /owned by another process/);
  assert.throws(() => controller.begin("trace-a2", 10, "rewritten"), /different prompt/);
});

test("duplicate manual start preserves the original deadline and running lease shape", () => {
  const { controller } = fixture();
  const first = controller.begin("trace-retry", 10, "original");
  const repeated = controller.begin("trace-retry", 10, "original");
  assert.equal(repeated.deadlineAt, first.deadlineAt);
  controller.confirmSent(first.tabId);
  controller.started("trace-retry", 10);
  assert.equal(controller.begin("trace-retry", 10, "original").deadlineAt, null);
  controller.end("trace-retry", 10, "completed");
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
