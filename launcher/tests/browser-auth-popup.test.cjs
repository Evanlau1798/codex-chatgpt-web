const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const vm = require("node:vm");
const path = require("node:path");

function fixture() {
  const views = [];
  class View {
    constructor(options) {
      this.options = options;
      this.webContents = options.webContents || Object.assign(new EventEmitter(), {
        isDestroyed: () => false, getURL: () => "about:blank", setZoomFactor() {},
        setWindowOpenHandler() {}, close() {}, stop() {},
        loads: [], async loadURL(url) { this.loads.push(url); },
      });
      views.push(this);
    }
    setBounds() {} setVisible() {}
  }
  const filename = path.resolve(__dirname, "../electron/browser-host.cjs");
  const requireSource = createRequire(filename);
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, "utf8")}\n})`, { filename })(
    id => id === "electron" ? { ...requireSource(id), WebContentsView: View } : requireSource(id), module, module.exports,
  );
  const { BrowserHost } = module.exports;
  let primaryLoads = 0;
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    partition: "persist:codex-web-gpt-chatgpt", authView: null,
    state: { zoomFactor: 1 }, bounds: { x: 0, y: 0, width: 800, height: 600 },
    manualOperation: "ChatGPT login", view: { webContents: {
      isDestroyed: () => false, async loadURL() { primaryLoads++; },
    } },
    window: { contentView: { addChildView() {}, removeChildView() {} } },
    logger: { info() {}, error() {} }, bindShellZoomShortcuts() {}, syncViewVisibility() {},
    setState() {}, probeAuthentication: async () => {},
  });
  return { host, views, primaryLoads: () => primaryLoads };
}

test("deferred authentication popup shares the partition and starts its requested navigation", async () => {
  const { host, views } = fixture();
  try {
    const contents = host.createAuthView({}, "https://auth.openai.com/authorize");
    assert.equal(views[0].options.webPreferences?.partition, host.partition);
    assert.equal(Object.hasOwn(views[0].options, "webContents"), false);
    assert.equal(views[0].options.webPreferences?.nodeIntegration, false);
    assert.equal(views[0].options.webPreferences?.sandbox, true);
    assert.deepEqual(contents.loads, ["https://auth.openai.com/authorize"]);
  } finally { host.closeAuthView(host.authView, true, false); }
});

test("replacing an authentication popup never reloads its opener or replaces supplied contents", () => {
  const { host, views, primaryLoads } = fixture();
  const first = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, getURL: () => "about:blank", setZoomFactor() {},
    setWindowOpenHandler() {}, close() {},
    loadURL: () => { throw new Error("Electron already owns supplied-guest navigation"); },
  });
  const second = Object.assign(new EventEmitter(), { ...first });
  try {
    host.createAuthView({ webContents: first }, "https://auth.openai.com/authorize");
    const contents = host.createAuthView({ webContents: second }, "https://accounts.google.com/authorize");
    assert.equal(contents, second);
    assert.equal(views[1].options.webContents, second);
    assert.equal(primaryLoads(), 0);
  } finally { host.closeAuthView(host.authView, true, false); }
});
