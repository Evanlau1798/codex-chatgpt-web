const assert = require("node:assert/strict");
const test = require("node:test");
const { BrowserHost } = require("../electron/browser-host.cjs");

test("duplicate retained tabs do not expose their conversation fingerprint", async () => {
  const fingerprint = "a".repeat(64);
  const tabs = ["first", "second"].map((id) => [id, {
    id,
    traceId: `trace-${id}`,
    status: "ready",
    interactionMode: "automatic",
    conversationKey: fingerprint,
    connectorIdentity: "Codex Native2",
    connectorBound: true,
  }]);
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null,
    turnTabs: new Map(tabs),
    userCancelledTurnOwners: new Map(),
  });

  await assert.rejects(
    () => BrowserHost.prototype.beginTurn.call(
      fixture, "trace-next", false, 123, true, fingerprint, "Codex Native2",
    ),
    (error) => {
      assert.match(error.message, /multiple browser tabs/);
      assert.doesNotMatch(error.message, new RegExp(fingerprint));
      return true;
    },
  );
});
