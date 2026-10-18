const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");

test("real browser host preserves the default Electron UA for home, turns, standby and authentication", {
  skip: !process.env.LAUNCHER_TEST_ELECTRON,
}, () => {
  const env = { ...process.env, BROWSER_UA_OWNER_PID: String(process.pid) };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(process.env.LAUNCHER_TEST_ELECTRON,
    [resolve(__dirname, "fixtures/browser-user-agent.cjs")], {
      env, encoding: "utf8", timeout: 30000, windowsHide: true,
    });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /BROWSER_DEFAULT_UA_OK/);
});
