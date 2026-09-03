const assert = require("node:assert/strict");
const test = require("node:test");
const { BrowserControlServer } = require("../electron/control-server.cjs");

test("manual control endpoints require the token and preserve lifecycle order", async () => {
  const calls = [];
  const host = {
    browserInteractionMode: () => "manual",
    beginManualTurn: (...args) => { calls.push(["start", ...args]); return { tabId: "tab", reused: false, deadlineAt: null, state: "awaiting-user" }; },
    waitManualSent: async () => ({ status: "sent", sentAt: null }),
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
    assert.equal((await post("start", { traceId: "trace-z1", helperPid: 7, prompt: "p" })).status, 200);
    assert.equal((await post("started", { traceId: "trace-z1", helperPid: 7 })).status, 200);
    assert.equal((await post("end", { traceId: "trace-z1", helperPid: 7, status: "completed" })).status, 200);
    assert.deepEqual(calls.map(call => call[0]), ["start", "started", "end"]);
  } finally {
    await server.close();
  }
});
