const test = require("node:test");
const assert = require("node:assert/strict");
const { releaseRetainedConversation } = require("../electron/retained-turn-release.cjs");

test("retained conversation release closes every matching ready tab and leaves running tabs alone", () => {
  const removed = [];
  const events = [];
  const tabs = [
    { id: "ready-a", status: "ready", conversationKey: "a".repeat(64) },
    { id: "running-a", status: "running", conversationKey: "a".repeat(64) },
    { id: "ready-b", status: "ready", conversationKey: "b".repeat(64) },
    { id: "ready-a-duplicate", status: "ready", conversationKey: "a".repeat(64) },
  ];
  const host = {
    turnTabs: new Map(tabs.map(tab => [tab.id, tab])),
    logger: { info: (event, detail) => events.push([event, detail]) },
    removeTurnTab: (tab, abortRunning) => {
      assert.equal(abortRunning, false);
      removed.push(tab.id);
      host.turnTabs.delete(tab.id);
    },
  };

  assert.equal(releaseRetainedConversation(host, "a".repeat(64)), 2);
  assert.deepEqual(removed, ["ready-a", "ready-a-duplicate"]);
  assert.deepEqual([...host.turnTabs.keys()], ["running-a", "ready-b"]);
  assert.deepEqual(events, [
    ["browser.tab_released", {
      tabId: "ready-a",
      traceId: undefined,
      status: "ready",
      reason: "retained_conversation_superseded",
    }],
    ["browser.tab_released", {
      tabId: "ready-a-duplicate",
      traceId: undefined,
      status: "ready",
      reason: "retained_conversation_superseded",
    }],
  ]);
});

test("retained conversation release is a no-op without a matching ready tab", () => {
  const host = {
    turnTabs: new Map([["running", {
      id: "running",
      status: "running",
      conversationKey: "a".repeat(64),
    }]]),
    removeTurnTab: () => { throw new Error("running tab must not be removed"); },
    logger: { info: () => { throw new Error("no release event is expected"); } },
  };

  assert.equal(releaseRetainedConversation(host, "a".repeat(64)), 0);
});
