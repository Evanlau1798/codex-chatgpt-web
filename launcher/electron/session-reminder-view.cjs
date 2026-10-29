const path = require("node:path");
const { WebContentsView, ipcMain } = require("electron");
const { registerLoggedIpc } = require("./logging.cjs");
const CARD_WIDTH = 430;
const CARD_TOP = 60;
const CARD_RIGHT = 18;
const SHADOW_PADDING = 8;

// Shell notices are native siblings above the browser views, which are inserted
// at index zero. Their stacking never changes the browser's measured bounds.
class SessionReminderView {
  constructor({ parent, loadRenderer, getLanguage, onAction, logger }) {
    this.parent = parent;
    this.parentContents = parent.webContents;
    this.loadRenderer = loadRenderer;
    this.getLanguage = getLanguage;
    this.onAction = onAction;
    this.view = null;
    this.height = 0;
    this.channels = [];
    const handle = (name, source, callback) => {
      const channel = `launcher:session-reminder-${name}`;
      this.channels.push(channel);
      registerLoggedIpc(ipcMain, logger, channel, (event, ...args) => {
        const contents = source === "parent" ? parent.webContents : this.view?.webContents;
        if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame) {
          throw new Error("Session reminder request came from an unrelated renderer");
        }
        return callback(...args);
      });
    };
    handle("visible", "parent", visible => {
      if (typeof visible !== "boolean") throw new Error("Session reminder visibility must be boolean");
      return this.setVisible(visible);
    });
    handle("language", "notice", async () => { await this.ready; return this.getLanguage(); });
    handle("height", "notice", height => {
      if (!Number.isFinite(height) || height < 1 || height > 2_000) throw new Error("Invalid session reminder height");
      this.height = Math.ceil(height);
      this.position();
    });
    handle("action", "notice", async action => {
      if (action !== "dismiss" && action !== "logout") throw new Error("Unknown session reminder action");
      const view = this.view;
      await this.onAction(action);
      if (this.view === view) this.close();
    });
    this.reposition = () => this.position();
    this.events = ["resize", "show", "hide", "minimize", "restore", "enter-full-screen", "leave-full-screen"];
    for (const event of this.events) parent.on(event, this.reposition);
    this.parentContents.on("zoom-changed", this.reposition);
    parent.once("closed", () => this.destroy());
    this.closeOnLoad = () => this.close();
    this.parentContents.on("did-start-loading", this.closeOnLoad);
  }

  async setVisible(visible) {
    if (!visible) { this.close(); return; }
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.webContents.send("launcher:session-reminder-language-changed", this.getLanguage());
      this.position();
      return;
    }
    const view = new WebContentsView({
      webPreferences: { preload: path.join(__dirname, "session-reminder-preload.cjs"),
        contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    this.view = view;
    this.height = 0;
    view.setBackgroundColor("#00000000");
    view.setBounds({ x: 0, y: 0, width: CARD_WIDTH + 2 * SHADOW_PADDING, height: 220 });
    view.setVisible(false);
    this.parent.contentView.addChildView(view);
    view.webContents.on("will-navigate", event => event.preventDefault());
    view.webContents.on("will-redirect", event => event.preventDefault());
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.ready = Promise.resolve().then(() => this.loadRenderer(view.webContents)).then(() => {
      if (this.view !== view) throw new Error("Session reminder was closed while loading");
      const zoom = this.parent.webContents.getZoomFactor();
      this.place({ x: 0, y: 0, width: Math.round((CARD_WIDTH + 2 * SHADOW_PADDING) * zoom), height: Math.round(220 * zoom) });
    });
    try { await this.ready; }
    catch (error) {
      if (this.view !== view) return;
      this.close();
      throw error;
    }
  }

  position() {
    const view = this.view;
    if (!view || view.webContents.isDestroyed() || this.parent.isDestroyed()) return;
    if (!this.height || !this.parent.isVisible() || this.parent.isMinimized()) {
      view.setVisible(false);
      return;
    }
    const [parentWidth, parentHeight] = this.parent.getContentSize();
    const zoom = this.parent.webContents.getZoomFactor();
    const width = Math.round(Math.min(CARD_WIDTH * zoom, parentWidth - 2 * CARD_RIGHT * zoom) + 2 * SHADOW_PADDING * zoom);
    const y = Math.round((CARD_TOP - SHADOW_PADDING) * zoom);
    this.place({ x: Math.round(parentWidth - width - (CARD_RIGHT - SHADOW_PADDING) * zoom), y,
      width, height: Math.min(Math.ceil(this.height * zoom), parentHeight - y) });
    view.setVisible(true);
  }

  place(bounds) {
    const zoom = this.parent.webContents.getZoomFactor();
    if (this.view.webContents.getZoomFactor() !== zoom) this.view.webContents.setZoomFactor(zoom);
    const key = `${bounds.width}:${bounds.height}`;
    if (this.viewport !== key) {
      // Hidden native views otherwise expose a zero-sized renderer viewport.
      this.view.webContents.enableDeviceEmulation({ screenPosition: "desktop",
        screenSize: { width: bounds.width, height: bounds.height }, viewPosition: { x: 0, y: 0 },
        deviceScaleFactor: 0, viewSize: { width: bounds.width, height: bounds.height }, scale: 1 });
      this.viewport = key;
    }
    this.view.setBounds(bounds);
  }

  close() {
    const view = this.view;
    this.view = null;
    this.height = 0;
    this.viewport = null;
    if (view) {
      if (!this.parent.isDestroyed()) this.parent.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
  }

  destroy() {
    this.close();
    for (const event of this.events) this.parent.removeListener(event, this.reposition);
    this.parentContents.removeListener("zoom-changed", this.reposition);
    this.parentContents.removeListener("did-start-loading", this.closeOnLoad);
    for (const channel of this.channels) ipcMain.removeHandler(channel);
  }
}

module.exports = { SessionReminderView };
