const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

function supervisorFixture() {
  return new RuntimeSupervisor({
    app: { getVersion: () => "3.0.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
}

test("explicit launcher shutdown cancels active turns before the graceful stop", async () => {
  const actions = [];
  const supervisor = supervisorFixture();
  supervisor.cancelActiveTurns = async () => {
    actions.push("cancel-turns");
    return { cancelledHttpTurns: 1, cancelledBrowserTurns: 1 };
  };
  supervisor.stopForSetup = async () => {
    actions.push("graceful-stop");
    return { status: "stopped" };
  };

  assert.deepEqual(
    await supervisor.shutdown({ cancelActiveTurns: true, force: true }),
    { status: "stopped" },
  );
  assert.deepEqual(actions, ["cancel-turns", "graceful-stop"]);
});

test("explicit launcher shutdown force-stops only its owned runtime when graceful shutdown fails", async () => {
  const actions = [];
  const supervisor = supervisorFixture();
  supervisor.cancelActiveTurns = async () => { actions.push("cancel-turns"); };
  supervisor.stopForSetup = async () => {
    actions.push("graceful-stop");
    throw new Error("daemon still reports one HTTP turn");
  };
  supervisor.forceStopOwnedRuntime = async error => {
    actions.push(`forced-stop:${error.message}`);
    return { status: "forced", detail: error.message };
  };

  assert.deepEqual(
    await supervisor.shutdown({ cancelActiveTurns: true, force: true }),
    { status: "forced", detail: "daemon still reports one HTTP turn" },
  );
  assert.deepEqual(actions, [
    "cancel-turns",
    "graceful-stop",
    "forced-stop:daemon still reports one HTTP turn",
  ]);
});
