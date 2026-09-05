const assert = require("node:assert/strict");
const test = require("node:test");
const { BrowserControlServer } = require("../electron/control-server.cjs");

test("manual mode rejects automatic admission and typed inspection without dispatch", async () => {
  const calls = [];
  const host = {
    browserInteractionMode: () => "manual",
    beginTurn() { calls.push("start"); },
    inspectSession() { calls.push("inspect"); },
  };
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} }, getBrowserHost: () => host, getPreferences: () => ({}),
  }).start();
  const { endpoint, token } = server.descriptor();
  try {
    for (const [path, status, code] of [
      ["/v1/turn/start", 400, undefined],
      ["/v1/session/inspect", 409, "manual_browser_inspection_disabled"],
    ]) {
      const response = await fetch(endpoint + path, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ traceId: "manual-denied", helperPid: process.pid, detectCapabilities: true }),
      });
      assert.equal(response.status, status);
      if (code) assert.equal((await response.json()).code, code);
    }
    assert.deepEqual(calls, []);
  } finally { await server.close(); }
});

test("manual control endpoints require the token and preserve lifecycle order", async () => {
  const calls = [];
  const host = {
    browserInteractionMode: () => "manual",
    beginManualTurn: (...args) => { calls.push(["start", ...args]); return { tabId: "tab", reused: false, deadlineAt: null, state: "awaiting-user" }; },
    waitManualSent: async () => ({ status: "sent", sentAt: null }),
    waitManualTerminal: async () => ({ status: "timeout" }),
    markManualTurnStarted: (...args) => { calls.push(["started", ...args]); return {}; },
    endManualTurn: (...args) => { calls.push(["end", ...args]); return { cancelledByUser: false }; },
  };
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} }, getBrowserHost: () => host, getPreferences: () => ({}),
  }).start();
  const descriptor = server.descriptor();
  const post = (action, body, token = descriptor.token) => fetch(`${descriptor.endpoint}/v1/manual/${action}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await post("start", { traceId: "trace-z1", helperPid: 7, prompt: "p" }, "wrong")).status, 401);
    assert.equal((await post("start", { traceId: "trace-z1", helperPid: 7, prompt: "p", compaction: true })).status, 200);
    assert.equal(calls[0][6], true);
    assert.equal((await post("started", { traceId: "trace-z1", helperPid: 7 })).status, 200);
    assert.equal((await post("end", { traceId: "trace-z1", helperPid: 7, status: "completed" })).status, 200);
    assert.deepEqual(calls.map(call => call[0]), ["start", "started", "end"]);
    const timedOut = await post("wait-terminal", { traceId: "trace-z1", helperPid: 7 });
    assert.equal(timedOut.status, 408);
    assert.equal((await timedOut.json()).code, "manual_turn_timed_out");
  } finally {
    await server.close();
  }
});
