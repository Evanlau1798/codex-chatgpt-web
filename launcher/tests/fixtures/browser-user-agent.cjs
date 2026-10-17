const { app, BrowserWindow, WebContentsView, session } = require("electron");
const { createServer } = require("node:http");
const { once } = require("node:events");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { BrowserHost } = require("../../electron/browser-host.cjs");
const root = path.resolve(__dirname, "../../../tmp/browser-user-agent");
fs.mkdirSync(root, { recursive: true });
const userData = fs.mkdtempSync(path.join(root, "run-"));
app.setPath("userData", userData);
app.on("window-all-closed", () => {});
const owner = Number(process.env.BROWSER_UA_OWNER_PID || process.ppid);
setInterval(() => {
  try { process.kill(owner, 0); } catch (error) { if (error.code === "ESRCH") app.exit(1); }
}, 250).unref();
setTimeout(() => app.exit(1), 25000).unref();

app.whenReady().then(async () => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ ua: req.headers["user-agent"], hints: req.headers["sec-ch-ua"] });
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><title>UA fixture</title>");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const expectedVersion = process.versions.chrome;
  let exitCode = 1;
  try {
    for (const profile of ["production", "development"]) {
      app.setName(profile === "production" ? "Codex Web GPT" : "Codex Web GPT DEV");
      const defaultUA = session.defaultSession.getUserAgent();
      const partition = profile === "production" ? "persist:codex-web-gpt-chatgpt" : "persist:codex-web-gpt-dev-chatgpt";
      const browserSession = session.fromPartition(partition);
      const nativeUA = browserSession.getUserAgent();
      await browserSession.cookies.set({ url: origin, name: "preserved", value: "yes" });
      const window = new BrowserWindow({ show: false });
      const baseline = new WebContentsView({ webPreferences: { partition, sandbox: true } });
      await baseline.webContents.loadURL(origin);
      const baselineHints = requests.at(-1).hints;
      const baselineMetadata = await baseline.webContents.executeJavaScript(
        "navigator.userAgentData.getHighEntropyValues(['fullVersionList'])");
      baseline.webContents.close();
      let host;
      try {
        host = new BrowserHost({ window, profile, partition,
          descriptorPath: path.join(userData, profile + ".json"), cdpPort: 0,
          getConnectorName: () => "Codex Native2", loginWithPasskey: async () => {},
          logger: { info() {}, warn() {}, error() {} }, helper: {}, control: {},
        });
        await host.ready();
        const surfaces = [host.view.webContents];
        surfaces.push((await host.createTurnTab("ua-turn", process.pid)).view.webContents);
        surfaces.push((await host.createTurnTab("ua-standby", process.pid, true,
          undefined, "Codex Native2", false, undefined, true)).view.webContents);
        const guest = new WebContentsView({ webPreferences: { partition, sandbox: true } });
        surfaces.push(host.createAuthView({ webContents: guest.webContents }, "https://auth.openai.com/authorize"));
        for (const contents of surfaces) {
          assert.equal(contents.session, browserSession);
          await contents.loadURL(origin);
          const observed = await contents.executeJavaScript(`(async()=>({
            ua:navigator.userAgent,
            hints:await navigator.userAgentData.getHighEntropyValues(['fullVersionList']),
          }))()`);
          assert.equal(observed.ua, nativeUA);
          assert.ok(observed.ua.includes(`Chrome/${expectedVersion}`));
          assert.ok(observed.hints.fullVersionList.some(b => b.brand === "Chromium" && b.version === expectedVersion));
          assert.equal(requests.at(-1).ua, observed.ua);
          assert.equal(requests.at(-1).hints, baselineHints);
          assert.deepEqual(observed.hints, baselineMetadata);
          assert.equal(contents.getUserAgent(), browserSession.getUserAgent());
        }
        assert.equal((await browserSession.cookies.get({ url: origin, name: "preserved" }))[0]?.value, "yes");
        assert.equal(session.defaultSession.getUserAgent(), defaultUA);
      } finally { host?.destroy(); window.destroy(); }
    }
    console.log("BROWSER_DEFAULT_UA_OK native UA / engine / client hints / all surfaces / cookie and default session preserved");
    exitCode = 0;
  } catch (error) { console.error(error.stack); }
  finally { server.closeAllConnections(); server.close(); }
  app.exit(exitCode);
}).catch(error => { console.error(error.stack); app.exit(1); });
