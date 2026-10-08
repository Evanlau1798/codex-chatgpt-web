const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createLauncherSurface, viewBounds, dashboardOrigin, CHANNEL, RELOAD } = require('./launcher-surface.cjs');
const { patchSources } = require('./launcher-ui-patch.cjs');

function fixture() {
  const handlers = new Map(), external = [], children = [], browserVisibility = [], constructed = [];
  const window = new EventEmitter();
  window.webContents = { mainFrame: {}, getZoomFactor: () => 1.25 };
  window.getContentSize = () => [1000, 700];
  window.contentView = { addChildView: view => children.push(view), removeChildView: view => children.splice(children.indexOf(view), 1) };
  class View {
    constructor(options) {
      constructed.push(options);
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        loads: [], setWindowOpenHandler(handler) { this.popup = handler; },
        async loadURL(url) { this.loads.push(url); }, async insertCSS() {},
        isDestroyed() { return this.closed === true; }, close() { this.closed = true; },
      });
    }
    setBounds(bounds) { this.bounds = bounds; }
  }
  const surface = createLauncherSurface({ window, settings: { dashboardPort: 10100 }, waitForReady: async () => {},
    getBrowserHost: () => ({ setSurfaceActive: value => browserVisibility.push(value) }),
      electron: { WebContentsView: View, ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key), on() {}, removeListener() {} },
      shell: { openExternal: async url => { external.push(url); } } },
  });
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const show = () => handlers.get(CHANNEL)(event, { active: true, bounds: { x: 200, y: 50, width: 600, height: 500 } });
  return { surface, handlers, event, show, window, external, children, browserVisibility, constructed };
}

test('same-window dashboard uses a sandboxed session without launcher preload or Node access', async () => {
  const f = fixture(); await f.show();
  assert.equal(f.children.length, 1);
  assert.deepEqual(f.browserVisibility, [false]);
  assert.deepEqual(f.surface.view.bounds, { x: 250, y: 63, width: 750, height: 625 });
  assert.deepEqual(f.surface.view.webContents.loads, ['http://127.0.0.1:10100/#dashboard']);
  const prefs = f.constructed[0].webPreferences;
  assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.preload, undefined);
  assert.equal(prefs.partition, 'persist:codex-web-gpt-opencodex');
});

test('switching surfaces retains dashboard navigation, session and form state', async () => {
  const f = fixture(); await f.show(); const view = f.surface.view;
  await f.handlers.get(CHANNEL)(f.event, { active: false });
  assert.equal(f.children.length, 0); assert.equal(f.surface.active, false);
  await f.show(); assert.equal(f.surface.view, view); assert.equal(view.webContents.loads.length, 1);
  await f.handlers.get(RELOAD)(f.event); assert.equal(view.webContents.loads.length, 2);
  f.window.emit('closed'); assert.equal(view.webContents.closed, true); assert.equal(f.handlers.size, 0);
});

test('dashboard and subframes cannot invoke privileged launcher controls', async () => {
  const f = fixture();
  for (const event of [{ sender: {}, senderFrame: {} }, { ...f.event, senderFrame: {} }]) {
    await assert.rejects(f.handlers.get(CHANNEL)(event, { active: false }), /main frame/);
    await assert.rejects(f.handlers.get(RELOAD)(event), /main frame/);
  }
  assert.equal(f.constructed.length, 0);
});

test('OAuth and external links leave the unprivileged view without replacing the launcher', async () => {
  const f = fixture(); await f.show(); const contents = f.surface.view.webContents;
  let prevented = 0;
  contents.emit('will-navigate', { preventDefault() { prevented++; } }, 'http://127.0.0.1:10100/#providers');
  assert.equal(prevented, 0);
  contents.emit('will-redirect', { preventDefault() { prevented++; } }, 'https://accounts.example.com/oauth');
  assert.equal(prevented, 1); assert.deepEqual(f.external, ['https://accounts.example.com/oauth']);
  for (const url of ['javascript:alert(1)', 'file:///C:/private', 'https://user:password@example.com']) {
    assert.deepEqual(contents.popup({ url }), { action: 'deny' });
  }
  assert.equal(f.external.length, 1);
});

test('bounds are validated, scaled for shell zoom and clamped inside its content area', () => {
  assert.deepEqual(viewBounds({ x: -2, y: 10, width: 2000, height: 2000 }, 2, [1000, 700]), { x: 0, y: 20, width: 1000, height: 680 });
  assert.throws(() => viewBounds({ x: NaN, y: 0, width: 1, height: 1 }, 1, [1000, 700]), /Invalid/);
  assert.throws(() => dashboardOrigin({ dashboardPort: '10100' }), /Invalid/);
});

test('an unavailable dashboard can be reloaded without restarting the gateway', async () => {
  const f = fixture(); await f.show();
  const contents = f.surface.view.webContents;
  contents.loadURL = async () => { throw new Error('offline'); };
  await assert.rejects(f.handlers.get(RELOAD)(f.event), /unavailable/);
  contents.loadURL = async () => {};
  assert.equal(await f.handlers.get(RELOAD)(f.event), true);
});

test('a future incompatible official renderer is rejected before files are changed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencodex-renderer-contract-'));
  fs.mkdirSync(path.join(dir, 'src'));
  const file = path.join(dir, 'src/App.tsx'); const before = 'export function FutureLauncher() {}';
  fs.writeFileSync(file, before);
  assert.throws(() => patchSources(dir, __dirname), /changed/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.unlinkSync(file); fs.rmdirSync(path.join(dir, 'src')); fs.rmdirSync(dir);
});
