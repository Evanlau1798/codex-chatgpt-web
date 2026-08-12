const test = require("node:test");
const assert = require("node:assert/strict");
const { BrowserControlServer } = require("../electron/control-server.cjs");

test("browser control server authenticates and owns turn visibility", async () => {
  const calls = [];
  const logs = [];
  const host = {
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
      body: JSON.stringify({ phase: "heartbeat", traceId: "abcdef123456", helperPid: process.pid }),
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
    assert.deepEqual(calls, [
      ["start", "abcdef123456", true, process.pid, true, "a".repeat(64), "Codex Native2", true],
      ["heartbeat", "abcdef123456", process.pid],
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
