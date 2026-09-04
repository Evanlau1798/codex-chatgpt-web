const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const os = require("node:os");
const { RuntimeHost } = require("../electron/runtime.cjs");

test("a browser-mode commit failure restores the previous runtime inside setup", async () => {
  const previousConfig = {
    mode: "full",
    browserHost: "launcher",
    browserInteractionMode: "manual",
    releaseVersion: "1.1.3",
  };
  let stops = 0;
  let starts = 0;
  let checkpointRestores = 0;
  let runtimeRestores = 0;
  const host = new RuntimeHost({
    app: {
      getPath: () => path.join(os.tmpdir(), "codex-web-gpt-browser-commit-rollback"),
      getVersion: () => "1.1.3",
    },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor: {
      readSetupConfig: () => previousConfig,
      readConfig: () => previousConfig,
      stopForSetup: async () => { stops += 1; },
      startIfConfigured: async () => { starts += 1; return { status: "ready" }; },
    },
  });
  host.captureSetupCheckpoint = () => ({ exact: "checkpoint" });
  host.setupCheckpointChanged = () => true;
  host.restoreSetupCheckpoint = () => { checkpointRestores += 1; };
  host.restorePreviousRuntime = async () => { runtimeRestores += 1; };
  host.run = async () => ({ code: 0, stdout: "", stderr: "" });

  await assert.rejects(
    host.runSetup("browser-interaction-mode", ["setup", "--full"], {
      afterRuntimeReady: async () => { throw new Error("surface ownership failed"); },
    }),
    /surface ownership failed/,
  );
  assert.equal(stops, 1);
  assert.equal(starts, 1);
  assert.equal(checkpointRestores, 1);
  assert.equal(runtimeRestores, 1);
});
