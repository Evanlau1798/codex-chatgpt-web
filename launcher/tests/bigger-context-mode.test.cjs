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

test("manual Bigger Context is rejected before setup can stop the runtime", async () => {
  const { assertBiggerContextChangeAllowed } = require("../electron/context-mode.cjs");
  assert.throws(() => assertBiggerContextChangeAllowed({ browserInteractionMode: "manual" }, true), /Zero Risk/);
  assert.doesNotThrow(() => assertBiggerContextChangeAllowed({ browserInteractionMode: "manual" }, false));
});

test("manual settings wire the interaction boundary and explain standard context", () => {
  const source = require("node:fs").readFileSync(path.join(__dirname, "../src/App.tsx"), "utf8");
  assert.match(source, /biggerContextSwitchState\(\{\s*browserInteractionMode: snapshot\.state\.browserInteractionMode,/);
  assert.match(source, /browserInteractionMode === "manual" \? copy\.manualBiggerContextBody : copy\.biggerContextBody/);
  assert.match(source, /checked=\{snapshot\.state\.showBrowserDuringTurns\}\s*disabled=\{snapshot\.state\.browserInteractionMode === "manual"\}/);
});
