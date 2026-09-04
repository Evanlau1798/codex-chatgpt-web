const assert = require("node:assert/strict");
const test = require("node:test");
const { BrowserHost } = require("../electron/browser-host.cjs");

test("an Automatic turn never reuses a retained Zero Risk conversation", async () => {
  const conversationKey = "m".repeat(64);
  const retained = {
    id: "manual-retained",
    traceId: "trace_manual",
    status: "ready",
    interactionMode: "manual",
    conversationKey,
    connectorIdentity: "Codex Native2",
    connectorBound: true,
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null,
    turnTabs: new Map([[retained.id, retained]]),
    userCancelledTurnOwners: new Map(),
    createTurnTab: () => ({ id: "automatic-fresh", surfaceId: "surface-fresh" }),
    syncViewVisibility() {},
    publishState() {},
    snapshot: () => ({ tabs: [] }),
    logger: { info() {} },
  });

  assert.deepEqual(
    await BrowserHost.prototype.beginTurn.call(
      fixture,
      "trace_automatic",
      false,
      222,
      true,
      conversationKey,
      "Codex Native2",
    ),
    {
      surfaceId: "surface-fresh",
      tabId: "automatic-fresh",
      reused: false,
    },
  );
  assert.equal(retained.status, "ready");
  await assert.rejects(
    BrowserHost.prototype.beginTurn.call(
      fixture,
      "trace_manual",
      false,
      222,
      true,
      conversationKey,
      "Codex Native2",
    ),
    /already belongs to Zero Risk interaction/,
  );
});

test("interaction-mode changes preserve mode-bound retained tabs on failure and after commit", async () => {
  const retainedAutomatic = { id: "automatic-ready", status: "ready" };
  const retainedManual = { id: "manual-ready", status: "ready", interactionMode: "manual" };
  let ownershipMarks = 0;
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    getBrowserInteractionMode: () => "manual",
    interactionModeOverride: null,
    manualOperation: null,
    turnTabs: new Map([
      [retainedAutomatic.id, retainedAutomatic],
      [retainedManual.id, retainedManual],
    ]),
    selectedTabId: retainedAutomatic.id,
    markOwnedSurface: async () => { ownershipMarks += 1; },
    snapshot: () => ({ activeTabId: "home" }),
  });

  await assert.rejects(
    fixture.withInteractionModeChange("automatic", async () => {
      assert.equal(fixture.currentOperation(), "browser interaction mode change");
      assert.equal(fixture.browserInteractionMode(), "automatic");
      throw new Error("runtime setup failed");
    }),
    /runtime setup failed/,
  );
  assert.equal(fixture.turnTabs.size, 2);
  assert.equal(fixture.currentOperation(), null);
  assert.equal(fixture.browserInteractionMode(), "manual");
  assert.equal(ownershipMarks, 0);

  const result = await fixture.withInteractionModeChange("automatic", async commit => {
    await commit();
    return "configured";
  });
  assert.equal(result, "configured");
  assert.deepEqual([...fixture.turnTabs.keys()], [retainedAutomatic.id, retainedManual.id]);
  assert.equal(fixture.selectedTabId, retainedAutomatic.id);
  assert.equal(fixture.currentOperation(), null);
  assert.equal(ownershipMarks, 1);

  const live = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([["running", { id: "running", status: "running" }]]),
    removeTurnTab: () => { throw new Error("live tab must not be removed"); },
  });
  assert.throws(
    () => live.assertTurnTabsCanResetForInteractionModeChange(),
    /Finish or cancel active ChatGPT turns/,
  );
});

test("switching from Zero Risk to Automatic marks the already-loaded primary surface", async () => {
  const scripts = [];
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    getBrowserInteractionMode: () => "manual",
    interactionModeOverride: null,
    manualOperation: null,
    turnTabs: new Map(),
    selectedTabId: "home",
    surfaceId: "automatic-primary-surface",
    view: { webContents: {
      executeJavaScript: async script => { scripts.push(script); },
    } },
    snapshot: () => ({ activeTabId: "home" }),
  });

  assert.equal(await fixture.withInteractionModeChange("automatic", async commit => {
    await commit();
    return "configured";
  }), "configured");
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /__CODEX_WEB_GPT_SURFACE_ID__/);
  assert.match(scripts[0], /automatic-primary-surface/);
});

test("a failed Automatic ownership proof stays inside the runtime rollback boundary", async () => {
  const retained = { id: "retained-before-failed-switch", status: "ready" };
  let rollbackBoundaryObserved = false;
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    getBrowserInteractionMode: () => "manual",
    interactionModeOverride: null,
    manualOperation: null,
    turnTabs: new Map([[retained.id, retained]]),
    selectedTabId: retained.id,
    markOwnedSurface: async () => { throw new Error("surface ownership failed"); },
  });

  await assert.rejects(
    fixture.withInteractionModeChange("automatic", async commit => {
      try {
        await commit();
      } catch (error) {
        // RuntimeHost executes this callback before leaving runSetup's rollback-protected try.
        rollbackBoundaryObserved = true;
        throw error;
      }
    }),
    /surface ownership failed/,
  );
  assert.equal(rollbackBoundaryObserved, true);
  assert.deepEqual([...fixture.turnTabs.keys()], [retained.id]);
  assert.equal(fixture.browserInteractionMode(), "manual");
});

test("terminal Zero Risk tabs are reclaimed before retained conversations", () => {
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map(), removeTurnTab(tab) { this.turnTabs.delete(tab.id); },
  });
  fixture.turnTabs.set("manual-timeout", {
    id: "manual-timeout",
    interactionMode: "manual",
    status: "error",
    manualState: "timed-out",
    lastHeartbeatAt: 1,
  });
  fixture.turnTabs.set("manual-retained", {
    id: "manual-retained",
    interactionMode: "manual",
    status: "ready",
    manualState: "completed",
    lastHeartbeatAt: 0,
  });

  assert.equal(fixture.evictOldestReclaimableTurnTab(), true);
  assert.equal(fixture.turnTabs.has("manual-timeout"), false);
  assert.equal(fixture.turnTabs.has("manual-retained"), true);
});
