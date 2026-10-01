const test = require("node:test");
const assert = require("node:assert/strict");
const { BrowserControlServer } = require("../electron/control-server.cjs");

test("startup controls authenticate, validate metadata and preserve ownership", async () => {
  const calls = [];
  const host = {
    browserInteractionMode: () => "automatic",
    beginTurn: async (...args) => { calls.push(["start", ...args]); return { surfaceId: "a".repeat(32) }; },
    markStartupPrepared: (trace, pid) => {
      if (trace !== "startup_owner" || pid !== process.pid) throw new Error("wrong owner");
      calls.push(["prepared", trace, pid]); return { prepared: true };
    },
    discardStartupPages: () => { calls.push(["cancel"]); return { closed: 1 }; },
  };
  const preferences = { experimentalPreparedWebSession: true };
  const server = await new BrowserControlServer({ getBrowserHost: () => host, getPreferences: () => preferences,
    logger: { info() {}, warn() {}, error() {} } }).start();
  const { endpoint, token } = server.descriptor();
  const send = (route, body = {}, auth = token) => fetch(`${endpoint}/v1/${route}`, {
    method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const owner = { traceId: "startup_owner", helperPid: process.pid };
  try {
    for (const route of ["turn/prepared", "startup/cancel"]) {
      assert.equal((await send(route, owner, "wrong")).status, 401);
    }
    assert.equal(calls.length, 0);
    for (const metadata of [{ startupPreparation: "true" }, { allowStartupPreparation: "true" },
      { startupSurfaceId: "invalid" }, { startupPreparation: true, startupSurfaceId: "a".repeat(32) }]) {
      assert.equal((await send("turn/start", { ...owner, ...metadata })).status, 400);
    }
    assert.equal((await send("turn/prepared", { ...owner, startupPreparation: true })).status, 400);
    assert.equal((await send("turn/prepared", { ...owner, helperPid: process.pid + 1 })).status, 400);
    assert.equal(calls.length, 0);
    assert.equal((await send("turn/start", { ...owner, startupPreparation: true })).status, 200);
    assert.equal(calls[0][4], true); // A prepared harness stays locked independently of UI preference.
    assert.deepEqual(calls[0][9], { preparing: true, surfaceId: undefined, allowed: false });
    assert.deepEqual(await (await send("turn/prepared", owner)).json(), { ok: true, prepared: true });
    assert.deepEqual(await (await send("startup/cancel")).json(), { ok: true, closed: 1 });
    assert.equal(calls.filter(c => c[0] === "cancel").length, 1);
    preferences.experimentalPreparedWebSession = false;
    const before = calls.length;
    assert.equal((await send("turn/start", { ...owner, startupPreparation: true })).status, 400);
    assert.equal(calls.length, before);
    await send("turn/start", { ...owner, startupSurfaceId: "a".repeat(32), allowStartupPreparation: true });
    assert.equal(calls.at(-1)[9].surfaceId, undefined);
    assert.equal(calls.at(-1)[9].allowed, false);
  } finally { await server.close(); }
});
