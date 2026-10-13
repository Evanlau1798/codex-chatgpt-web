const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { BrowserHost } = require("../electron/browser-host.cjs");
const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");

test("real Electron loading and authentication popup boundaries", { skip: !process.env.LAUNCHER_TEST_ELECTRON }, () => {
  const env = { ...process.env, LOGIN_RECOVERY_OWNER_PID: String(process.pid) };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.LOGIN_RECOVERY_BASELINE;
  delete env.LOGIN_RECOVERY_RESULT_PATH;
  const result = spawnSync(process.env.LAUNCHER_TEST_ELECTRON,
    [resolve(__dirname, "fixtures/login-recovery.cjs")], { env, encoding: "utf8", timeout: 25000, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("resizing loading primary and auth surfaces does not queue renderer execution", async () => {
  function surface() {
    const contents = new EventEmitter();
    let loading = true;
    let scripts = 0;
    Object.assign(contents, {
      isDestroyed: () => false,
      isLoadingMainFrame: () => loading,
      executeJavaScript: () => {
        scripts++;
        // Electron defers execution until the main-frame load settles.
        return loading ? new Promise(resolve => contents.once("did-stop-loading", resolve)) : Promise.resolve();
      },
    });
    return {
      view: { webContents: contents, setBounds() {} },
      ready() { loading = false; contents.emit("did-stop-loading"); },
      scripts: () => scripts,
    };
  }
  const home = surface();
  const auth = surface();
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    window: { getContentSize: () => [1200, 800] },
    view: home.view, authView: auth.view, turnTabs: new Map(), syncViewVisibility() {},
  });
  for (let i = 0; i < 12; i++) host.setBounds({ x: 260, y: 60, width: 800 + i, height: 600 });
  assert.equal(home.view.webContents.listenerCount("did-stop-loading"), 0);
  assert.equal(auth.view.webContents.listenerCount("did-stop-loading"), 0);
  assert.equal(home.scripts() + auth.scripts(), 0);
  home.ready(); auth.ready();
  host.setBounds({ x: 260, y: 60, width: 840, height: 620 });
  assert.equal(home.scripts(), 1);
  assert.equal(auth.scripts(), 1);
});
