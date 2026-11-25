const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { scripts } = require("../package.json");

test("launcher initializes Electron before starting parallel test workers", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-test-electron-"));
  try {
    const electron = join(root, "node_modules", "electron");
    mkdirSync(electron, { recursive: true });
    mkdirSync(join(root, "tests"));
    writeFileSync(join(electron, "index.js"), `
      const fs = require("node:fs");
      const path = require("node:path").join(__dirname, "initialized-by");
      if (!fs.existsSync(path)) fs.writeFileSync(path, String(process.pid));
      module.exports = fs.readFileSync(path, "utf8");
    `);
    const worker = `
      const test = require("node:test");
      const assert = require("node:assert/strict");
      const initializedBy = require("electron");
      test("Electron was initialized outside this worker", () => {
        assert.notEqual(initializedBy, String(process.pid), "worker started the Electron installer");
      });
    `;
    const files = ["first.test.cjs", "second.test.cjs"].map(name => join(root, "tests", name));
    files.forEach(file => writeFileSync(file, worker));
    const [command, ...args] = scripts.test.split(" ");
    assert.equal(command, "node");
    assert.equal(args.pop(), "tests/*.test.cjs");
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [...args, "--test-concurrency=2", ...files], {
      cwd: root, env, encoding: "utf8", timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(readFileSync(join(electron, "initialized-by"), "utf8"), /^\d+$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
