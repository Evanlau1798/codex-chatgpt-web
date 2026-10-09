const { app, BrowserWindow, WebContentsView } = require("electron");
const { BrowserHost } = require("../../electron/browser-host.cjs");

// Playwright's Windows shell may survive its test owner, so watch the owner itself.
const ownerPid = Number(process.env.VIEWPORT_TEST_OWNER_PID || process.ppid);
if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) throw new Error("Invalid viewport test owner");
setInterval(() => {
  try { process.kill(ownerPid, 0); }
  catch (error) {
    if (error.code === "ESRCH") app.exit(0);
    else if (error.code !== "EPERM") throw error;
  }
}, 250).unref();

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1120, height: 760, show: false });
  await window.loadURL("about:blank");
  const view = new WebContentsView();
  window.contentView.addChildView(view);
  await view.webContents.loadURL("about:blank");
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    window, view, boundsReady: true,
    bounds: { x: 280, y: 64, width: 840, height: 656 },
    visible: true, surfaceActive: true, authView: null,
    turnTabs: new Map(), selectedTabId: "second", closedTurnOwners: new Map(),
    syncPowerSaveBlocker() {}, snapshot() { return {}; }, writeDescriptor() {},
  });
  for (const id of ["first", "second"]) {
    const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } });
    const tab = {
      id, view, status: "running", rendererReady: false,
      deviceEmulationDirty: true, deviceEmulationViewport: null,
    };
    host.turnTabs.set(id, tab);
    window.contentView.addChildView(view);
    host.presentTurnView(tab, false);
    await view.webContents.loadURL("data:text/html," + encodeURIComponent(`
      <button onclick="document.querySelector('[role=menu]').hidden=false">Models</button>
      <div role="menu" hidden><button role="menuitemradio" aria-checked="false"
        onclick="this.setAttribute('aria-checked','true')">GPT-5.6 Sol</button></div>
      <script>window.resizes=[];window.lastResizeAt=performance.now();addEventListener('resize',()=>{
        window.lastResizeAt=performance.now();
        resizes.push([innerWidth,innerHeight]);document.querySelector('[role=menu]').hidden=true;
      });</script>`) + "#" + id);
    tab.rendererReady = true;
  }
  window.showInactive();
  host.syncViewVisibility();
  global.viewportFixture = host;
});
