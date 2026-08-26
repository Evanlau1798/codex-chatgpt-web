const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { RuntimeHost } = require("../electron/runtime.cjs");

test("Bigger Context cannot be enabled while Enhanced Web session mode is active", async () => {
  const config = {
    mode: "browser-only",
    useEnhancedWebSessionMode: true,
    experimentalBiggerContext: false,
  };
  const host = new RuntimeHost({
    app: {
      getPath: () => path.join(os.tmpdir(), "codex-web-gpt-context-mode-test"),
      getVersion: () => "1.1.3",
    },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor: {
      readConfig: () => config,
      readSetupConfig: () => config,
    },
  });
  let invoked = false;
  host.runSetup = async () => { invoked = true; };

  await assert.rejects(
    host.setBiggerContext(true),
    /unavailable while Enhanced Web session mode is enabled/,
  );
  assert.equal(invoked, false);
});
