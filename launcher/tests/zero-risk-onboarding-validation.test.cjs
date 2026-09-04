const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const main = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");

function fixture() {
  let handler;
  let writes = 0;
  let autostarts = 0;
  const start = main.indexOf('  handle("launcher:complete-onboarding",');
  const end = main.indexOf("\n  });", start);
  const context = {
    app: {}, setAutostart() { autostarts++; }, updateTrayMenu() {}, logger: { info() {} },
    stateStore: {
      read: () => ({ githubOpened: true, xOpened: true, autoStart: true }),
      update: patch => { writes++; return patch; },
    },
    handle: (_name, callback) => { handler = callback; },
  };
  const validation = main.slice(main.indexOf("function validateLanguage("), main.indexOf("function validateBounds("));
  vm.runInNewContext(`${validation}\n${main.slice(start, end + 6)}`, context);
  return { run: (...args) => handler(null, ...args), effects: () => [writes, autostarts] };
}

test("onboarding rejects invalid interaction and language before persistence or autostart", () => {
  for (const [language, mode] of [["en", "other"], ["en", null], ["en", undefined], ["other", "manual"]]) {
    const state = fixture();
    assert.throws(() => state.run(language, mode));
    assert.deepEqual(state.effects(), [0, 0]);
  }
});

test("onboarding persists both supported choices without coercion", () => {
  for (const mode of ["automatic", "manual"]) {
    const state = fixture();
    const next = state.run("ja", mode);
    assert.equal(next.browserInteractionMode, mode);
    assert.equal(next.language, "ja");
    assert.equal(next.onboardingComplete, true);
    assert.deepEqual(state.effects(), [1, 1]);
  }
});
