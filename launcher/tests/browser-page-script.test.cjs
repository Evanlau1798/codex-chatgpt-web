const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { runBrowserPageScript } = require("../electron/browser-page-script.cjs");

function page(executeJavaScript) {
  return Object.assign(new EventEmitter(), {
    isDestroyed: () => false, isCrashed: () => false, executeJavaScript,
  });
}

for (const event of ["render-process-gone", "destroyed", "did-start-navigation"]) {
  test(`a pending page script settles on ${event} and removes its listeners`, async () => {
    let complete;
    const contents = page(() => new Promise(resolve => { complete = resolve; }));
    const result = runBrowserPageScript(contents, "fixture");
    const rejected = assert.rejects(result, /renderer stopped|browser closed|page changed/);
    contents.emit(event, {}, "https://chatgpt.com/", false, true);
    await rejected;
    complete("stale result");
    assert.deepEqual(contents.eventNames(), []);
  });
}

test("a renderer that never replies cannot leave a page check pending forever", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const contents = page(() => new Promise(() => {}));
  const rejected = assert.rejects(runBrowserPageScript(contents, "fixture", 100), /timed out/);
  t.mock.timers.tick(100);
  await rejected;
  assert.deepEqual(contents.eventNames(), []);
});

test("subframes and same-document navigation preserve a valid page result", async () => {
  let complete;
  const contents = page(() => new Promise(resolve => { complete = resolve; }));
  const result = runBrowserPageScript(contents, "fixture");
  contents.emit("did-start-navigation", {}, "https://chatgpt.com/", false, false);
  contents.emit("did-start-navigation", {}, "https://chatgpt.com/#x", true, true);
  complete({ authenticated: true });
  assert.deepEqual(await result, { authenticated: true });
  assert.deepEqual(contents.eventNames(), []);
});

test("a known crashed renderer is rejected before asking Electron to run a script", async () => {
  const contents = page(() => assert.fail("script reached a dead renderer"));
  contents.isCrashed = () => true;
  await assert.rejects(runBrowserPageScript(contents, "fixture"), /renderer is unavailable/);
});
