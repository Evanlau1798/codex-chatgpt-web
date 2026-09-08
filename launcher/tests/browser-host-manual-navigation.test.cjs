const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { BrowserHost } = require("../electron/browser-host.cjs");

test("the production browser binding forwards manual main-frame navigation", () => {
  const calls = [];
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = () => {};
  contents.getURL = () => "https://chatgpt.com/c/retained";
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    manualTurns: { navigation: (...args) => calls.push(args) },
    publishState() {},
    snapshot() { return {}; },
    syncViewVisibility() {},
  });
  const tab = {
    id: "tab-1",
    traceId: "trace-1",
    interactionMode: "manual",
    view: { webContents: contents },
  };
  host.bindTurnContents(tab);

  contents.emit("did-start-navigation", {}, "https://chatgpt.com/c/reload", false, true);
  contents.emit("did-navigate-in-page", {}, "https://chatgpt.com/c/reload#answer", true);
  contents.emit("did-start-navigation", {}, "https://example.com/frame", false, false);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(([, url, inPlace]) => [url, inPlace]), [
    ["https://chatgpt.com/c/reload", false],
    ["https://chatgpt.com/c/reload#answer", true],
  ]);
});
