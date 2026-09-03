const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { BrowserHost } = require("../electron/browser-host.cjs");

test("manual turn navigation never injects code, styles, or page-derived titles", async () => {
  const calls = [];
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = () => {};
  contents.getURL = () => "https://chatgpt.com/?temporary-chat=true";
  for (const method of ["insertCSS", "executeJavaScript", "getTitle"]) {
    contents[method] = () => { calls.push(method); return Promise.resolve(); };
  }
  const tab = { view: { webContents: contents }, interactionMode: "manual", pageTitle: "ChatGPT" };
  const host = {
    logger: { warn() {}, error() {}, info() {} },
    syncViewVisibility() {}, snapshot() {}, publishState() {}, syncPowerSaveBlocker() {},
  };
  BrowserHost.prototype.bindTurnContents.call(host, tab);
  contents.emit("did-finish-load");
  contents.emit("page-title-updated", {}, "private conversation title");
  await Promise.resolve();
  assert.deepEqual(calls, []);
  assert.equal(tab.pageTitle, "ChatGPT");
});
