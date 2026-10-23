const fs = require('node:fs');
const path = require('node:path');

const CHANNEL = 'launcher:opencodex-surface';
const RELOAD = 'launcher:opencodex-reload';
const OPEN = 'launcher:opencodex-open-on-launch';
const SURFACE_INSTANCES = new WeakMap();

function dashboardOrigin(settings) {
  if (!Number.isInteger(settings.dashboardPort) || settings.dashboardPort < 1 || settings.dashboardPort > 65535) {
    throw new Error('Invalid OpenCodex dashboard port');
  }
  return `http://127.0.0.1:${settings.dashboardPort}`;
}

function viewBounds(bounds, zoom, size) {
  if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]))
      || !Number.isFinite(zoom) || zoom <= 0 || zoom > 5) throw new Error('Invalid OpenCodex view bounds');
  const x = Math.max(0, Math.min(size[0], Math.round(bounds.x * zoom)));
  const y = Math.max(0, Math.min(size[1], Math.round(bounds.y * zoom)));
  return {
    x, y,
    width: Math.max(0, Math.min(size[0] - x, Math.round(bounds.width * zoom))),
    height: Math.max(0, Math.min(size[1] - y, Math.round(bounds.height * zoom))),
  };
}

function externalUrl(url) {
  try { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password; }
  catch { return false; }
}

function createLauncherSurface({ window, getBrowserHost, logger, electron = require('electron'), settings, waitForReady }) {
  const { WebContentsView, ipcMain, shell } = electron;
  SURFACE_INSTANCES.get(ipcMain)?.dispose();
  const origin = dashboardOrigin(settings || JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8')));
  let view = null, active = false, loading = null, loadingPending = false, destroyed = false, attached = false, validationStarted = false;
  const log = (event, error) => logger?.warn(event, { message: error instanceof Error ? error.message : String(error) });
  const requireOwner = event => {
    if (destroyed || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('OpenCodex controls are reserved for the launcher main frame');
    }
  };
  const ensureView = () => {
    if (view) return view;
    view = new WebContentsView({ webPreferences: {
      partition: 'persist:codex-web-gpt-opencodex', contextIsolation: true,
      nodeIntegration: false, sandbox: true, spellcheck: true,
    } });
    const contents = view.webContents;
    const guard = (event, url) => {
      let local = false;
      try { local = new URL(url).origin === origin; } catch {}
      if (local) return;
      event.preventDefault();
      if (externalUrl(url)) void shell.openExternal(url).catch(error => log('opencodex.external_failed', error));
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.setWindowOpenHandler(({ url }) => {
      if (externalUrl(url)) void shell.openExternal(url).catch(error => log('opencodex.external_failed', error));
      return { action: 'deny' };
    });
    contents.on('render-process-gone', () => { loading = null; });
    // No launcher preload, no ChatGPT session and no native-tool authority enter this view.
    contents.on('did-finish-load', () => {
      void contents.insertCSS('* { -webkit-app-region: no-drag !important; }').catch(() => {});
      // Opt-in local installation evidence, with no diagnostic HTTP listener.
      if (process.env.OPENCODEX_LAUNCHER_VALIDATE === '1' && !validationStarted) {
        validationStarted = true;
        const timer = setTimeout(async () => {
          try {
            if (destroyed || !active) return;
            const directory = path.join(__dirname, 'validation');
            fs.mkdirSync(directory, { recursive: true });
            const isolation = await contents.executeJavaScript('({launcherApi:typeof window.codexWebLauncher, dashboardApi:typeof window.openCodexLauncher, node:typeof require, title:document.title})');
            fs.writeFileSync(path.join(directory, 'dashboard.png'), (await contents.capturePage()).toPNG());
            fs.writeFileSync(path.join(directory, 'launcher.png'), (await window.capturePage()).toPNG());
            fs.writeFileSync(path.join(directory, 'launcher-surface.json'), JSON.stringify({
              loaded: new URL(contents.getURL()).origin === origin, active, bounds: view.getBounds(),
              isolation, checkedAt: new Date().toISOString(),
            }, null, 2));
          } catch (error) { log('opencodex.validation_failed', error); }
        }, 2000);
        timer.unref();
      }
    });
    return view;
  };
  const load = () => {
    const target = ensureView();
    if (!loading) {
      loadingPending = true;
      loading = (async () => {
        if (waitForReady) await waitForReady();
        else {
          const deadline = Date.now() + 20000;
          while (true) {
            if (destroyed) throw new Error('OpenCodex view closed');
            try {
              const response = await fetch(origin + '/healthz', { signal: AbortSignal.timeout(2000) });
              await response.body?.cancel();
              if (response.ok) break;
            } catch {}
            if (Date.now() > deadline) throw new Error('OpenCodex service is not ready');
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
        if (destroyed) throw new Error('OpenCodex view closed');
        await target.webContents.loadURL(origin + '/#dashboard');
      })().catch(error => {
        loading = null;
        log('opencodex.dashboard_load_failed', error);
        throw new Error('OpenCodex dashboard is unavailable. Retry when its service is ready.');
      }).finally(() => { loadingPending = false; });
    }
    return loading;
  };
  const hide = () => {
    active = false;
    if (attached) { window.contentView.removeChildView(view); attached = false; }
  };
  const openOnLaunch = event => { requireOwner(event); event.returnValue = process.argv.includes('--opencodex'); };
  ipcMain.on(OPEN, openOnLaunch);
  ipcMain.handle(CHANNEL, async (event, input) => {
    requireOwner(event);
    if (typeof input?.active !== 'boolean') throw new Error('Invalid OpenCodex surface state');
    if (!input.active) { hide(); return true; }
    const bounds = viewBounds(input.bounds, event.sender.getZoomFactor(), window.getContentSize());
    getBrowserHost()?.setSurfaceActive(false);
    active = true;
    const target = ensureView();
    target.setBounds(bounds);
    if (!attached) { window.contentView.addChildView(target); attached = true; }
    await load();
    return true;
  });
  ipcMain.handle(RELOAD, async event => {
    requireOwner(event);
    if (!loadingPending) loading = null;
    await load();
    return true;
  });
  let surface;
  const dispose = () => {
    if (destroyed) return;
    hide(); destroyed = true;
    ipcMain.removeHandler(CHANNEL); ipcMain.removeHandler(RELOAD);
    ipcMain.removeListener(OPEN, openOnLaunch);
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
    if (SURFACE_INSTANCES.get(ipcMain) === surface) SURFACE_INSTANCES.delete(ipcMain);
  };
  window.once('closed', dispose);
  surface = { dispose, get active() { return active; }, get view() { return view; } };
  SURFACE_INSTANCES.set(ipcMain, surface);
  return surface;
}

module.exports = { createLauncherSurface, dashboardOrigin, viewBounds, externalUrl, CHANNEL, RELOAD, OPEN };
