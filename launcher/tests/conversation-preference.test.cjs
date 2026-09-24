const assert = require("node:assert/strict");
const fs = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const { BrowserHost } = require("../electron/browser-host.cjs");

test("off-on-off fresh conversation changes retire completed history before it can be reused", async () => {
  const vm = require("node:vm");
  const { releaseRetainedConversation } = require("../electron/retained-turn-release.cjs");
  const main = fs.readFileSync(resolve(__dirname, "../electron/main.cjs"), "utf8");
  for (const savedChats of [false, true]) {
    const property = savedChats ? "useSavedChats" : "experimentalFreshConversationPerTurn";
    const method = savedChats ? "setUseSavedChats" : "setFreshConversationPerTurn";
    const channel = savedChats ? "launcher:use-saved-chats" : "launcher:fresh-conversation-per-turn";
    const nextChannel = savedChats ? "launcher:set-preference" : "launcher:use-saved-chats";
    const key = "a".repeat(64);
    const stale = { id: "old-chat", traceId: "old-turn", status: "ready", interactionMode: "automatic",
      conversationKey: key, connectorIdentity: "Codex Native2", connectorBound: true };
    const manual = { id: "manual-chat", status: "ready", interactionMode: "manual", conversationKey: "b".repeat(64) };
    const state = { experimentalFreshConversationPerTurn: false, useSavedChats: false };
    const config = { useEnhancedWebSessionMode: false, browserInteractionMode: "automatic", experimentalFreshConversationPerTurn: false, useSavedChats: false };
    let handler, failSetup = true, commit;
    const removed = [];
    const fixture = Object.assign(Object.create(BrowserHost.prototype), {
      manualOperation: null, turnTabs: new Map([[stale.id, stale], [manual.id, manual]]),
      userCancelledTurnOwners: new Map(), selectedTabId: "home", logger: { info() {} },
      syncViewVisibility() {}, snapshot: () => ({}), publishState() {}, writeDescriptor() {},
      removeTurnTab(tab, abortRunning) {
        assert.equal(abortRunning, false);
        assert.equal(tab.status, "ready");
        removed.push(tab.id);
        this.turnTabs.delete(tab.id);
      },
      createTurnTab: async () => ({ id: "new-chat", surfaceId: "new-surface" }),
    });
    vm.runInNewContext(main.slice(main.indexOf("function syncFreshConversationPreference("), main.indexOf("function registerIpc(")) +
      main.slice(main.indexOf(`handle("${channel}",`),
      main.indexOf(`handle("${nextChannel}",`)), {
      handle: (_channel, callback) => { handler = callback; }, browserHost: fixture, releaseRetainedConversation,
      runtimeHost: { currentOperation: () => null, runtimeConfigSnapshot: () => ({ config }), [method]: async enabled => {
        if (failSetup) throw new Error("setup rejected");
        await new Promise(resolve => { commit = resolve; });
        config[property] = enabled;
        return { enabled };
      } },
      stateStore: { read: () => ({ ...state }), update: patch => Object.assign(state, patch) }, send() {},
    });
    await assert.rejects(() => handler(null, true), /setup rejected/);
    assert.equal(fixture.turnTabs.get(stale.id), stale, "failed setup preserves prior history");
    failSetup = false;
    const enabling = handler(null, true);
    assert.equal(fixture.turnTabs.has(stale.id), true, "pending setup must not release history");
    // A concurrent running lease must not be cancelled, even if it shares the released key.
    const running = { id: "concurrent", traceId: "concurrent-turn", status: "running", interactionMode: "automatic", conversationKey: key };
    fixture.turnTabs.set(running.id, running);
    commit();
    await enabling;
    assert.deepEqual(removed, savedChats ? [stale.id, manual.id] : [stale.id]);
    assert.equal(fixture.turnTabs.get(running.id), running);
    assert.equal(fixture.turnTabs.get(manual.id), savedChats ? undefined : manual);
    fixture.turnTabs.delete(running.id);
    const disabling = handler(null, false);
    commit();
    await disabling;
    const lease = await fixture.beginTurn("new-turn", false, 123, true, key, "Codex Native2");
    assert.equal(lease.reused, false);
    assert.equal(lease.tabId, "new-chat");
    assert.equal(state[property], false);
    assert.equal(fixture.turnTabs.get(manual.id), savedChats ? undefined : manual);
  }
});
