const test = require("node:test");
const assert = require("node:assert/strict");
const { BrowserHost, loadCommittedBrowserSurface, IDLE_BROWSER_URL } = require("../electron/browser-host.cjs");
const { BrowserControlServer } = require("../electron/control-server.cjs");

test("live task progress is owner-bound, preserves elapsed time, and clears on release", async () => {
  const tab = { id: "task-one", traceId: "trace-one", helperPid: process.pid, status: "running", interactionMode: "automatic" };
  const other = { ...tab, id: "task-two", traceId: "trace-two", helperPid: process.pid + 1 };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab], [other.id, other]]), closedTurnOwners: new Map(),
    selectedTabId: other.id, getBrowserInteractionMode: () => "automatic",
    syncViewVisibility() {},
    snapshot() { return { tabs: [...this.turnTabs.values()].map(value => this.tabSnapshot(value)) }; },
  });
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} }, getBrowserHost: () => host, getPreferences: () => ({}),
  }).start();
  const { endpoint, token } = server.descriptor();
  const owner = { traceId: tab.traceId, helperPid: tab.helperPid };
  const send = body => fetch(`${endpoint}/v1/turn/heartbeat`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ...owner, ...body }),
  });
  try {
    const progress = { stage: "chatgpt", activeToolCalls: 2 };
    assert.equal((await send({ progress, helperPid: other.helperPid })).status, 400);
    for (const invalid of [null, {}, { ...progress, stage: "safety-blocked" }, { ...progress, activeToolCalls: -1 },
      { ...progress, activeToolCalls: 0.5 }, { ...progress, prompt: "private" }]) {
      assert.equal((await send({ progress: invalid })).status, 400);
    }
    assert.equal(tab.activity, undefined);
    assert.equal((await send({ progress })).status, 200);
    assert.equal(tab.activity.state, "tools");
    const since = tab.activity.since;
    assert.equal((await send({ progress })).status, 200);
    assert.equal(tab.activity.since, since);
    host.setTurnApprovalPending(tab.traceId, tab.helperPid, true);
    assert.equal((await send({ progress })).status, 200);
    assert.equal(tab.activity.state, "approval");
    host.setTurnApprovalPending(tab.traceId, tab.helperPid, false);
    assert.equal(tab.activity.state, "tools");
    assert.equal((await send({ progress: { stage: "chatgpt", activeToolCalls: 0 } })).status, 200);
    assert.equal(tab.activity.state, "chatgpt");
    assert.equal(other.activity, undefined);
    assert.equal(host.selectedTabId, other.id);
    tab.status = "ready";
    assert.equal((await send({ progress })).status, 400);
    assert.equal(host.tabSnapshot(tab).activity, undefined);
    tab.status = "running";
    tab.authenticationRequired = true;
    assert.equal(host.tabSnapshot(tab).authenticationRequired, true);
    assert.equal(host.tabSnapshot(tab).activity, undefined);
  } finally { await server.close(); }
});

test("approval notices require the running tab's helper and never change another tab", async () => {
  const tab = { id: "approval-tab", label: "ChatGPT 1", traceId: "approval-turn", helperPid: process.pid,
    status: "running", interactionMode: "automatic" };
  const other = { ...tab, id: "other-tab", traceId: "another-turn", helperPid: process.pid + 1 };
  const events = [];
  let mode = "automatic";
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab], [other.id, other]]), closedTurnOwners: new Map(),
    selectedTabId: other.id, getBrowserInteractionMode: () => mode,
    syncViewVisibility() {},
    snapshot() { return { tabs: [...this.turnTabs.values()].map(value => this.tabSnapshot(value)) }; },
    publishState: state => events.push(state),
  });
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} }, getBrowserHost: () => host, getPreferences: () => ({}),
  }).start();
  const { endpoint, token } = server.descriptor();
  const send = (body, auth = token) => fetch(`${endpoint}/v1/turn/approval`, {
    method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const owner = { traceId: tab.traceId, helperPid: tab.helperPid };
  try {
    assert.equal((await send({ ...owner, pending: true }, "wrong-token")).status, 401);
    assert.equal((await send({ ...owner, pending: true, helperPid: other.helperPid })).status, 400);
    assert.equal((await send({ ...owner, pending: "true" })).status, 400);
    assert.equal((await send(owner)).status, 400);
    assert.equal(events.length, 0);
    assert.equal((await send({ ...owner, pending: true })).status, 200);
    assert.equal(tab.approvalPending, true);
    assert.equal(other.approvalPending, undefined);
    assert.equal(host.selectedTabId, other.id, "a notice must not switch away from the user's selected task");
    assert.equal(events.at(-1).tabs[0].approvalPending, true);
    host.heartbeatTurn(tab.traceId, tab.helperPid);
    assert.equal(tab.approvalPending, true, "normal heartbeats must not erase the notice");
    assert.equal((await send({ ...owner, pending: false })).status, 200);
    assert.equal(events.at(-1).tabs[0].approvalPending, undefined);
    tab.status = "error";
    assert.equal((await send({ ...owner, pending: true })).status, 400);
    tab.approvalPending = true;
    assert.equal(host.tabSnapshot(tab).approvalPending, undefined, "terminal tabs cannot retain an active notice");
    tab.status = "running";
    tab.authenticationRequired = true;
    assert.equal(host.tabSnapshot(tab).approvalPending, undefined);
    mode = "manual";
    assert.equal((await send({ ...owner, pending: true })).status, 400);
  } finally { await server.close(); }
});

test("disconnect cancels pending browser initialization and destroys only its owned document", async () => {
  const { EventEmitter } = require("node:events");
  for (const stalledAt of ["load", "mark"]) {
    let ready;
    const stalled = new Promise(resolve => { ready = resolve; });
    let settled;
    const finished = new Promise(resolve => { settled = resolve; });
    let pendingTab;
    let marks = 0;
    let closes = 0;
    const unrelated = { id: "unrelated", traceId: "other", status: "running", interactionMode: "automatic" };
    const host = Object.assign(Object.create(BrowserHost.prototype), {
      turnTabs: new Map([[unrelated.id, unrelated]]), userCancelledTurnOwners: new Map(), closedTurnOwners: new Map(),
      getBrowserInteractionMode: () => "automatic", logger: { info() {}, error() {} },
      window: { contentView: { removeChildView() {} } },
      syncPowerSaveBlocker() {}, syncViewVisibility() {}, writeDescriptor() {}, snapshot: () => ({}),
      async createTurnTab(traceId, helperPid, _locked, _conversation, _connector, _manual, signal) {
        let destroyed = false;
        let url = "about:blank";
        const contents = Object.assign(new EventEmitter(), {
          isDestroyed: () => destroyed, getURL: () => url, stop() {}, insertCSS: async () => {},
          loadURL: async target => {
            if (stalledAt === "load") { ready(); await new Promise(() => {}); }
            url = target;
          },
          executeJavaScript: async () => { marks++; ready(); await new Promise(() => {}); },
          close: () => { closes++; destroyed = true; contents.emit("destroyed"); },
        });
        pendingTab = { id: `pending-${stalledAt}`, traceId, helperPid, surfaceId: "a".repeat(32),
          status: "running", interactionMode: "automatic", initializingSurface: true, view: { webContents: contents } };
        this.turnTabs.set(pendingTab.id, pendingTab);
        try { await require("../electron/automatic-turn-surface.cjs").initializeAutomaticTurnTab(this, pendingTab, loadCommittedBrowserSurface, IDLE_BROWSER_URL, "", signal); return pendingTab; }
        finally { settled(); }
      },
    });
    const server = await new BrowserControlServer({
      logger: { info() {}, warn() {}, error() {} }, getPreferences: () => ({}), getBrowserHost: () => host,
    }).start();
    const { endpoint, token } = server.descriptor();
    const controller = new AbortController();
    try {
      const response = fetch(`${endpoint}/v1/turn/start`, {
        method: "POST", signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ traceId: "pending-start", helperPid: process.pid }),
      });
      const rejected = assert.rejects(response, { name: "AbortError" });
      await stalled;
      controller.abort();
      await rejected;
      await finished;
      assert.equal(closes, 1);
      assert.equal(marks, stalledAt === "mark" ? 1 : 0);
      assert.equal(pendingTab.initializingSurface, true);
      assert.equal(pendingTab.view.webContents.listenerCount("destroyed"), 0);
      assert.deepEqual([...host.turnTabs.values()], [unrelated]);
    } finally { controller.abort(); await server.close(); }
  }
});

test("Limits receipts require the active automatic owner and survive reconnect without duplicate usage", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { LimitsController } = require("../electron/limits-controller.cjs");
  const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "limits-control-"));
  const file = path.join(directory, "limits.json");
  const accountKey = "a".repeat(64);
  let mode = "automatic";
  const limits = new LimitsController(file, { getInteractionMode: () => mode });
  await limits.setup(async () => ({ accountKey, plan: "pro_200" }));
  const host = {
    browserInteractionMode: () => mode,
    turnTabs: new Map([["tab", { traceId: "limits-turn", helperPid: process.pid, status: "running" }]]),
    heartbeatTurn: BrowserHost.prototype.heartbeatTurn,
    snapshot: () => ({}),
    beginTurn: () => ({ surfaceId: "a".repeat(32), reused: false, connectorBound: false }),
  };
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => host, getPreferences: () => ({}), limits,
  }).start();
  const { endpoint, token } = server.descriptor();
  const send = (body, auth = token, route = "usage") => fetch(`${endpoint}/v1/turn/${route}`, {
    method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const owner = { traceId: "limits-turn", helperPid: process.pid };
  const body = { ...owner, receipt: { id: "one-accepted-send", accountKey, model: "gpt-6-pro", at: Date.now() } };
  try {
    assert.equal((await (await send(owner, token, "start")).json()).trackUsage, true);
    assert.equal((await send(body, "wrong-token")).status, 401);
    assert.equal((await send({ ...body, helperPid: process.pid + 1 })).status, 400);
    assert.equal(limits.snapshot().totalMessages, 0);
    assert.equal((await (await send(body)).json()).recorded, true);
    assert.equal((await (await send(body)).json()).recorded, false);
    const restored = new LimitsController(file, { getInteractionMode: () => mode });
    assert.equal(restored.snapshot().windows.find(window => window.model === "gpt-6-pro").used, 1);
    mode = "manual";
    assert.equal((await send({ ...body, receipt: { ...body.receipt, id: "manual-send" } })).status, 400);
    assert.equal(limits.snapshot().disabledReason, "zero-risk");
    assert.equal(limits.snapshot().totalMessages, 1);
  } finally {
    await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("native proxy resolution requires owner auth, restricts targets, and works without browser automation", async () => {
  const resolved = [];
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => { throw new Error("proxy resolution must not inspect browser contents"); },
    getPreferences: () => { throw new Error("proxy resolution must not depend on integration mode"); },
    resolveProxy: async url => { resolved.push(url); return "PROXY 127.0.0.1:7897"; },
  }).start();
  const { endpoint, token } = server.descriptor();
  const send = (url, authorization = `Bearer ${token}`) => fetch(`${endpoint}/v1/network/resolve-proxy`, {
    method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ url }),
  });
  try {
    const url = "https://chatgpt.com/backend-api/codex/models?client_version=0.153.4";
    assert.equal((await send(url, "Bearer wrong")).status, 401);
    for (const target of ["http://chatgpt.com/backend-api/codex/models", "https://example.com/", "https://secret@chatgpt.com/backend-api/codex/models", "https://chatgpt.com/backend-api/me"]) {
      assert.equal((await send(target)).status, 400);
    }
    const response = await send(url);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { proxy: "PROXY 127.0.0.1:7897" });
    assert.deepEqual(resolved, [url]);
    server.resolveProxy = async () => { throw new Error("private PAC address"); };
    const failure = await send(url);
    assert.equal(failure.status, 400);
    assert.deepEqual(await failure.json(), { error: "System proxy resolution failed" });
  } finally { await server.close(); }
});

test("browser control server authenticates and owns turn visibility", async () => {
  const calls = [];
  const logs = [];
  const host = {
    browserInteractionMode: () => "automatic",
    beginTurn: (...args) => {
      calls.push(["start", ...args]);
      return { surfaceId: "launcher_surface_id_0123456789AB", tabId: "tab-1" };
    },
    heartbeatTurn: (...args) => calls.push(["heartbeat", ...args]),
    endTurn: (...args) => calls.push(["end", ...args]),
  };
  const server = await new BrowserControlServer({
    logger: {
      info: (event, detail) => logs.push(["info", event, detail]),
      warn: (event, detail) => logs.push(["warn", event, detail]),
    },
    getBrowserHost: () => host,
    getPreferences: () => ({ showBrowserDuringTurns: true, lockBrowserDuringTurns: true }),
  }).start();
  const descriptor = server.descriptor();
  try {
    const unauthenticated = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phase: "start", traceId: "abcdef123456" }),
    });
    assert.equal(unauthenticated.status, 401);

    const invalidOwner = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ phase: "start", traceId: "abcdef123456", helperPid: 0 }),
    });
    assert.equal(invalidOwner.status, 400);

    const invalidViewportRoute = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        phase: "start", traceId: "abcdef123456", helperPid: process.pid, refreshViewport: true,
      }),
    });
    assert.equal(invalidViewportRoute.status, 400);

    const start = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        phase: "start",
        traceId: "abcdef123456",
        helperPid: process.pid,
        conversationKey: "a".repeat(64),
        connectorIdentity: "Codex Native2",
        requireRetainedConversation: true,
      }),
    });
    assert.equal(start.status, 200);

    const heartbeat = await fetch(`${descriptor.endpoint}/v1/turn/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        phase: "heartbeat", traceId: "abcdef123456", helperPid: process.pid, refreshViewport: true,
      }),
    });
    assert.equal(heartbeat.status, 200);

    const ownerlessEnd = await fetch(`${descriptor.endpoint}/v1/turn/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ phase: "end", traceId: "abcdef123456", status: "failed" }),
    });
    assert.equal(ownerlessEnd.status, 400);

    const end = await fetch(`${descriptor.endpoint}/v1/turn/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        phase: "end",
        traceId: "abcdef123456",
        helperPid: process.pid,
        status: "completed",
        retain: true,
        connectorBound: true,
      }),
    });
    assert.equal(end.status, 200);
    const acquisitionSignal = calls[0].pop();
    assert.ok(acquisitionSignal instanceof AbortSignal);
    assert.equal(acquisitionSignal.aborted, false);
    assert.deepEqual(calls, [
      [
        "start",
        "abcdef123456",
        true,
        process.pid,
        true,
        "a".repeat(64),
        "Codex Native2",
        true,
      ],
      ["heartbeat", "abcdef123456", process.pid, true, undefined],
      ["end", "abcdef123456", process.pid, "completed", true, undefined, true, true],
    ]);
    assert.equal(logs.some(([, event]) => event === "browser.turn_started"), true);
    assert.equal(logs.some(([, event]) => event === "browser.turn_ended"), true);
  } finally {
    await server.close();
  }
});

test("browser control server cuts off exactly one authenticated debug surface", async () => {
  const calls = [];
  const host = {
    snapshot: () => ({
      tabs: [{
        tabId: "tab-smoke",
        id: "tab-smoke",
        traceId: "trace_smoke",
        status: "ready",
      }],
    }),
    closeTab: (tabId) => calls.push(tabId),
  };
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {} },
    getBrowserHost: () => host,
    getPreferences: () => ({}),
  }).start();
  const descriptor = server.descriptor();
  const post = (body, authenticated = true) => fetch(`${descriptor.endpoint}/v1/debug/turn/cutoff`, {
    method: "POST",
    headers: {
      ...(authenticated ? { authorization: `Bearer ${descriptor.token}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  try {
    assert.equal((await post({ traceId: "trace_smoke" }, false)).status, 401);
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ traceId: "trace_smoke", tabId: "tab-smoke" })).status, 400);

    const closed = await post({ traceId: "trace_smoke" });
    assert.equal(closed.status, 200);
    assert.deepEqual(await closed.json(), {
      ok: true,
      tabId: "tab-smoke",
      traceId: "trace_smoke",
      status: "ready",
      aborted: false,
    });

    assert.equal((await post({ traceId: "missing_trace" })).status, 404);
    assert.deepEqual(calls, ["tab-smoke"]);
  } finally {
    await server.close();
  }
});

test("browser control server releases only ready tabs for an authenticated conversation key", async () => {
  const removed = [];
  const releaseEvents = [];
  const ready = {
    id: "ready-tab",
    traceId: "ready-trace",
    status: "ready",
    conversationKey: "a".repeat(64),
  };
  const running = { id: "running-tab", status: "running", conversationKey: "a".repeat(64) };
  const host = {
    turnTabs: new Map([[ready.id, ready], [running.id, running]]),
    logger: { info: (event, detail) => releaseEvents.push([event, detail]) },
    removeTurnTab: (tab, abortRunning) => {
      assert.equal(abortRunning, false);
      removed.push(tab.id);
      host.turnTabs.delete(tab.id);
    },
  };
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {} },
    getBrowserHost: () => host,
    getPreferences: () => ({}),
  }).start();
  const descriptor = server.descriptor();
  try {
    const response = await fetch(`${descriptor.endpoint}/v1/turn/release`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ conversationKey: "a".repeat(64) }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, released: 1 });
    assert.deepEqual(removed, ["ready-tab"]);
    assert.deepEqual([...host.turnTabs.keys()], ["running-tab"]);
    assert.deepEqual(releaseEvents, [["browser.tab_released", {
      tabId: "ready-tab",
      traceId: "ready-trace",
      status: "ready",
      reason: "retained_conversation_superseded",
    }]]);
  } finally {
    await server.close();
  }
});

test("browser control server delegates authenticated connector verification to the existing host operation", async () => {
  const calls = [];
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {} },
    getBrowserHost: () => ({
      connectorName: () => "Codex Native2",
      verifyConnector: async (name) => { calls.push(name); },
    }),
    getPreferences: () => ({}),
  }).start();
  const descriptor = server.descriptor();
  try {
    const response = await fetch(`${descriptor.endpoint}/v1/session/verify-connector`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { verified: true });
    assert.deepEqual(calls, ["Codex Native2"]);
  } finally {
    await server.close();
  }
});
