const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const main = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
const start = main.indexOf("function findFreePort()");
const end = main.indexOf("function send(", start);
assert(start >= 0 && end > start);
function allocator(result) {
  return vm.runInNewContext(`${main.slice(start, end)}\nfindFreePortBeforeReady;`, {
    process: { execPath: "trusted-electron", env: {} },
    spawnSync(exe, _args, options) {
      assert.equal(exe, "trusted-electron");
      assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1");
      assert.equal(options.windowsHide, true);
      return result;
    },
  });
}

test("startup accepts a verified loopback port from its owned child", () => {
  assert.equal(allocator({ status: 0, stdout: "19321" })(), 19321);
});

for (const stdout of ["0", "65536", "unexpected", "123\n456"]) {
  test(`startup rejects an invalid port receipt ${JSON.stringify(stdout)}`, () => {
    assert.throws(allocator({ status: 0, stdout }), /valid loopback port/);
  });
}

test("startup preserves a port probe launch failure", () => {
  const error = new Error("injected port timeout");
  assert.throws(allocator({ error }), candidate => candidate === error);
});

test("startup rejects a failed port probe without opening browser surfaces", () => {
  assert.throws(allocator({ status: 1, stderr: "injected listener failure" }), /injected listener failure/);
});
