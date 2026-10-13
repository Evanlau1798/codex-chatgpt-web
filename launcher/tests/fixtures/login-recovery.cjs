const { app, BrowserWindow, WebContentsView } = require("electron");
const { createServer } = require("node:http");
const { once } = require("node:events");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const report = text => {
  if (process.env.LOGIN_RECOVERY_RESULT_PATH) fs.appendFileSync(process.env.LOGIN_RECOVERY_RESULT_PATH, text+"\n");
  console.log(text);
};

const filename = path.resolve(__dirname, "../../electron/browser-host.cjs");
let BrowserHost;
if (process.env.LOGIN_RECOVERY_BASELINE === "1") {
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(execFileSync("git", ["show", "HEAD:launcher/electron/browser-host.cjs"], {
    cwd: path.resolve(__dirname, "../../.."), encoding: "utf8",
  }), filename);
  BrowserHost = mod.exports.BrowserHost;
} else ({ BrowserHost } = require(filename));

const owner = Number(process.env.LOGIN_RECOVERY_OWNER_PID || process.ppid);
const watchdog = setInterval(() => {
  try { process.kill(owner, 0); } catch (error) { if (error.code === "ESRCH") app.exit(1); }
}, 250);
watchdog.unref();
setTimeout(() => app.exit(1), 20000).unref();

app.whenReady().then(async () => {
  const responses = [];
  const server = createServer((req, res) => {
    if (req.url.startsWith("/slow")) responses.push(res);
    else res.end("<!doctype html><title>Local login fixture</title>");
  });
  let window, host, exitCode = 1;
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    window = new BrowserWindow({ show: false });
    const partition = `login-recovery-${process.pid}`;
    const view = new WebContentsView({ webPreferences: { partition } });
    const other = new WebContentsView({ webPreferences: { partition } });
    window.contentView.addChildView(view); window.contentView.addChildView(other);
    host = Object.assign(Object.create(BrowserHost.prototype), {
      window, view, authView: other, partition, state: { zoomFactor: 1 },
      turnTabs: new Map(), bounds: { x: 0, y: 0, width: 800, height: 600 },
      manualOperation: "ChatGPT login", logger: { info() {}, error() {} },
      bindShellZoomShortcuts() {}, syncViewVisibility() {}, setState() {},
      probeAuthentication: async () => {},
    });
    const loading = [view, other].map((v, i) => v.webContents.loadURL(`${origin}/slow?surface=${i}`).catch(() => {}));
    while (responses.length < 2) await new Promise(resolve => setTimeout(resolve, 10));
    const before = [view, other].map(v => v.webContents.listenerCount("did-stop-loading"));
    for (let i = 0; i < 12; i++) host.setBounds({ x: 0, y: 0, width: 800+i, height: 600 });
    assert.deepEqual([view, other].map(v => v.webContents.listenerCount("did-stop-loading")), before);
    responses.forEach(res => res.end("<!doctype html><title>Ready</title>")); await Promise.all(loading);
    window.contentView.removeChildView(other); other.webContents.close(); host.authView = null;

    // Isolate the network boundary; no real account, cookies or auth endpoint is accessed.
    const prototype = Object.getPrototypeOf(view.webContents);
    const originalLoad = prototype.loadURL;
    prototype.loadURL = function(url, ...args) {
      return originalLoad.call(this, url.startsWith("https:") ? `${origin}/login` : url, ...args);
    };
    let primaryLoads = 0;
    view.webContents.loadURL = function(...args) { primaryLoads++; return prototype.loadURL.apply(this, args); };
    try {
      const first = host.createAuthView({}, "https://auth.openai.com/authorize");
      assert.equal(first.session, view.webContents.session);
      while (!first.getURL().startsWith(origin) || first.isLoadingMainFrame()) await new Promise(resolve => setTimeout(resolve, 10));
      const guest = new WebContentsView({ webPreferences: { partition } });
      await guest.webContents.loadURL(`${origin}/guest`);
      assert.equal(host.createAuthView({ webContents: guest.webContents }, "https://accounts.google.com/authorize"), guest.webContents);
      assert.equal(primaryLoads, 0);
      report("LOGIN_RECOVERY_NATIVE_PASS loading listeners / shared partition / deferred navigation / opener preserved");
    } finally { prototype.loadURL = originalLoad; }
    exitCode = 0;
  } catch (error) {
    report(error.stack);
  } finally {
    responses.forEach(res => res.end());
    if (host?.authView) host.closeAuthView(host.authView, true, false);
    window?.destroy(); server.close();
  }
  app.exit(exitCode);
}).catch(error => { console.error(error.stack); app.exit(1); });
