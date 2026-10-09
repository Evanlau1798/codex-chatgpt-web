const { app, BrowserWindow, WebContentsView } = require("electron");
const { BrowserHost } = require("../../electron/browser-host.cjs");

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
