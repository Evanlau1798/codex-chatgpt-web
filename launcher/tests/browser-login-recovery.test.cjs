const test = require("node:test");
const assert = require("node:assert/strict");
const { BrowserHost } = require("../electron/browser-host.cjs");

function fixture({ cached = false, verified = false, error } = {}) {
  const calls = [];
  let url = "https://chatgpt.com/?temporary-chat=true";
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    state: { authenticated: cached },
    loginOperation: null,
    show() {},
    activateHomeSurface() {},
    snapshot() { return { ...this.state }; },
    logger: { info() {} },
    view: { webContents: {
      getURL: () => url,
      loadURL: async next => { calls.push(["navigate", next]); url = next; },
    } },
    withManualOperation: async (_name, action) => action(),
    probeAuthentication: async () => {
      calls.push(["probe"]);
      host.state = { authenticated: verified, status: error ? "error" : verified ? "ready" : "signed-out", message: error };
      return host.snapshot();
    },
    waitForAuthenticated: async () => {
      calls.push(["wait"]);
      if (!verified && url !== "https://chatgpt.com/auth/login") {
        throw new Error("Sign in stayed on the unauthenticated Temporary Chat");
      }
      return { authenticated: true };
    },
    runSessionInspection: async detect => { assert.equal(detect, false); calls.push(["inspect"]); },
  });
  return { host, calls };
}

for (const cached of [false, true]) {
  test(`Sign in starts authentication from a stale Temporary Chat (cached=${cached})`, async () => {
    const { host, calls } = fixture({ cached });
    assert.deepEqual(await host.openLogin(), { authenticated: true });
    assert.deepEqual(calls, [["probe"], ["navigate", "https://chatgpt.com/auth/login"], ["wait"], ["inspect"]]);
    assert.equal(host.loginOperation, null);
  });
}

test("Sign in freshly verifies a valid session without starting another login", async () => {
  const { host, calls } = fixture({ cached: true, verified: true });
  assert.deepEqual(await host.openLogin(), { authenticated: true });
  assert.deepEqual(calls, [["probe"], ["wait"], ["inspect"]]);
});

test("fresh authentication succeeds even if a previous UI error is still displayed", async () => {
  const { host, calls } = fixture({ cached: false, verified: true });
  const probe = host.probeAuthentication;
  host.probeAuthentication = async () => ({ ...await probe(), status: "error", message: "Previous operation failed" });
  assert.deepEqual(await host.openLogin(), { authenticated: true });
  assert.deepEqual(calls, [["probe"], ["wait"], ["inspect"]]);
});

test("a session verification error is preserved instead of forcing another login", async () => {
  const { host, calls } = fixture({ error: "Session verification timed out" });
  await assert.rejects(host.openLogin(), /Session verification timed out/);
  assert.deepEqual(calls, [["probe"]]);
  assert.equal(host.loginOperation, null);
});

test("concurrent stale-session Sign in requests share one probe and navigation", async () => {
  const { host, calls } = fixture({ cached: true });
  let finish;
  host.waitForAuthenticated = () => new Promise(resolve => { finish = resolve; });
  const first = host.openLogin();
  const second = host.openLogin();
  assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [["probe"], ["navigate", "https://chatgpt.com/auth/login"]]);
  finish({ authenticated: true });
  await first;
  assert.equal(calls.filter(([call]) => call === "inspect").length, 1);
});

test("failed login navigation releases ownership and preserves the navigation failure", async () => {
  const { host, calls } = fixture();
  host.view.webContents.loadURL = async () => { throw new Error("login navigation failed"); };
  await assert.rejects(host.openLogin(), /login navigation failed/);
  assert.deepEqual(calls, [["probe"]]);
  assert.equal(host.loginOperation, null);
});

test("Sign in cannot acquire a busy browser or inspect Zero Risk mode", async () => {
  const { host, calls } = fixture({ cached: true });
  host.withManualOperation = async () => { throw new Error("browser is already busy"); };
  await assert.rejects(host.openLogin(), /browser is already busy/);
  assert.deepEqual(calls, []);
  host.getBrowserInteractionMode = () => "manual";
  assert.throws(() => host.openLogin(), /disabled in Zero Risk mode/);
});
