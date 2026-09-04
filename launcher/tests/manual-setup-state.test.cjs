const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../electron/main.cjs"), "utf8");

function fixture({ pro = true, codex = false, claude = "missing", failure = false, probeFailure = false } = {}) {
  const state = { coreSetupComplete: false, codexSetupComplete: false, claudeSetupComplete: false,
    browserInteractionMode: "manual", zeroRiskProEnabled: !pro };
  const context = {
    ...require("../electron/runtime-setup-state.cjs"),
    IS_DEV_PROFILE: false, send() {},
    stateStore: { read: () => state, update: patch => Object.assign(state, patch) },
    runtimeHost: {
      setupMcp: async () => { if (failure) throw new Error("setup rejected"); return { stdout: "configured" }; },
      runtimeConfigSnapshot: () => ({ config: { browserInteractionMode: "manual", zeroRiskProEnabled: pro } }),
      bridgeStatus: async () => { if (probeFailure) throw new Error("status probe unavailable"); return { installed: codex, active: codex }; },
      claudeIntegrationStatus: () => claude,
    }, browserHost: {},
  };
  return { state, context };
}

for (const [codex, claude] of [[true, "missing"], [false, "current"], [true, "current"]]) {
  test(`manual MCP setup projects only verified client installations: ${codex}/${claude}`, async () => {
    const f = fixture({ codex, claude });
    const start = source.indexOf('  handle("launcher:setup-mcp",');
    const end = source.indexOf("\n  });", start);
    let handler;
    vm.runInNewContext(source.slice(start, end + 6), { ...f.context, handle: (_name, fn) => { handler = fn; } });
    await handler({}, { interactionMode: "manual" });
    assert.equal(f.state.coreSetupComplete, true);
    assert.equal(f.state.codexSetupComplete, codex);
    assert.equal(f.state.claudeSetupComplete, claude === "current");
    assert.equal(f.state.zeroRiskProEnabled, true);
    assert.equal(f.state.browserSmokePassed, undefined);
  });
}

test("failed manual setup leaves onboarding and Pro preferences unchanged", async () => {
  const f = fixture({ failure: true });
  const before = JSON.stringify(f.state);
  const start = source.indexOf('  handle("launcher:setup-mcp",');
  const end = source.indexOf("\n  });", start);
  let handler;
  vm.runInNewContext(source.slice(start, end + 6), { ...f.context, handle: (_name, fn) => { handler = fn; } });
  await assert.rejects(handler({}, { interactionMode: "manual" }), /setup rejected/);
  assert.equal(JSON.stringify(f.state), before);
});

test("post-commit status failure still publishes the committed mode without claiming client verification", async () => {
  const f = fixture({ probeFailure: true });
  f.state.browserInteractionMode = "automatic";
  let tabsReset = false;
  f.context.browserHost.withInteractionModeChange = async (_mode, action) => {
    const result = await action(); tabsReset = true; return result;
  };
  f.context.browserHost.snapshot = () => ({});
  const start = source.indexOf('  handle("launcher:setup-mcp",');
  const end = source.indexOf("\n  });", start);
  let handler;
  vm.runInNewContext(source.slice(start, end + 6), { ...f.context, handle: (_name, fn) => { handler = fn; } });
  await handler({}, { interactionMode: "manual" });
  assert.equal(f.state.browserInteractionMode, "manual");
  assert.equal(f.state.coreSetupComplete, true);
  assert.equal(f.state.codexSetupComplete, false);
  assert.equal(tabsReset, true);
});

for (const pro of [true, false]) test(`startup reconciles persisted Zero Risk Pro=${pro}`, () => {
  const f = fixture({ pro });
  const start = source.indexOf("  const configured", source.indexOf("  runtimeHost = new RuntimeHost("));
  const end = source.indexOf("  browserHost = new BrowserHost(", start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(source.slice(start, end), f.context);
  assert.equal(f.state.zeroRiskProEnabled, pro);
});
