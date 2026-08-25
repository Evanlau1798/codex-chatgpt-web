const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { runObservedProcess } = require("../scripts/package-smoke-process.cjs");

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return true;
  };
  return child;
}

test("observed package process reports bounded progress and succeeds", async () => {
  const child = fakeChild();
  const logs = [];
  const promise = runObservedProcess("installer.exe", ["/S"], {
    heartbeatMs: 5,
    timeoutMs: 100,
    logger: (line) => logs.push(line),
    spawnProcess: () => child,
    stage: "Windows installer",
  });

  child.stdout.write("installed\n");
  child.emit("close", 0, null);

  const result = await promise;
  assert.equal(result.stdout, "installed\n");
  assert.equal(result.stderr, "");
  assert.equal(child.killed, false);
  assert.ok(logs.some((line) => line.includes("stage=Windows_installer") && line.includes("pid=4242")));
});

test("observed package process terminates and diagnoses a hard timeout", async () => {
  const child = fakeChild(5252);
  const promise = runObservedProcess("installer.exe", ["/S"], {
    heartbeatMs: 5,
    timeoutMs: 20,
    logger: () => {},
    spawnProcess: () => child,
    stage: "Windows installer",
  });

  child.stderr.write("installer remained active\n");

  await assert.rejects(
    promise,
    (error) => error.code === "ETIMEDOUT"
      && error.message.includes("Windows installer")
      && error.message.includes("pid 5252")
      && error.message.includes("installer remained active"),
  );
  assert.equal(child.killed, true);
});

test("observed package process preserves non-zero exit diagnostics", async () => {
  const child = fakeChild(6262);
  const promise = runObservedProcess("installer.exe", ["/S"], {
    heartbeatMs: 50,
    timeoutMs: 100,
    logger: () => {},
    spawnProcess: () => child,
    stage: "Windows installer",
  });

  child.stderr.write("installation failed\n");
  child.emit("close", 7, null);

  await assert.rejects(
    promise,
    /Windows installer failed with status 7: installation failed/,
  );
});
