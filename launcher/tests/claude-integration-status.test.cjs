const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  inspectClaudeIntegrationStatus,
  reconcileClaudeSetupState,
} = require("../electron/claude-integration-status.cjs");

const EVENTS = ["UserPromptSubmit", "PostToolUse", "PostToolUseFailure"];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-claude-status-"));
  return {
    root,
    journalPath: path.join(root, "integration-journal.json"),
    settingsPath: path.join(root, "settings.json"),
  };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function managedHook(url = "http://127.0.0.1:17841/v1/messages/steering") {
  return {
    hooks: [{
      type: "http",
      url,
      timeout: 5,
      headers: { Authorization: "Bearer $CODEX_CHATGPT_WEB_CONTROL_TOKEN" },
      allowedEnvVars: ["CODEX_CHATGPT_WEB_CONTROL_TOKEN"],
    }],
  };
}

function journal(hook, hookEvents) {
  return {
    version: 1,
    installed: {
      hook,
      ...(hookEvents ? { hookEvents } : {}),
      hookAdded: true,
    },
  };
}

test("does not claim manually configured hooks without a managed journal", (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.root, { recursive: true, force: true }));
  const hook = managedHook();
  writeJson(files.settingsPath, { hooks: Object.fromEntries(EVENTS.map(event => [event, [hook]])) });

  assert.equal(inspectClaudeIntegrationStatus(files), "missing");
});

test("marks legacy and drifted Claude steering hooks as outdated", (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.root, { recursive: true, force: true }));
  const hook = managedHook();
  writeJson(files.journalPath, journal(hook));
  writeJson(files.settingsPath, { hooks: { UserPromptSubmit: [hook] } });
  assert.equal(inspectClaudeIntegrationStatus(files), "outdated");

  writeJson(files.journalPath, journal(hook, EVENTS));
  writeJson(files.settingsPath, {
    hooks: Object.fromEntries(EVENTS.map(event => [event, [managedHook("http://127.0.0.1:1/wrong")]])),
  });
  assert.equal(inspectClaudeIntegrationStatus(files), "outdated");
});

test("accepts the managed hook on all three events alongside user hooks", (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.root, { recursive: true, force: true }));
  const hook = managedHook();
  const userHook = { hooks: [{ type: "command", command: "user-hook" }] };
  writeJson(files.journalPath, journal(hook, EVENTS));
  writeJson(files.settingsPath, {
    hooks: Object.fromEntries(EVENTS.map(event => [event, [userHook, hook]])),
  });

  assert.equal(inspectClaudeIntegrationStatus(files), "current");
});

test("reconciles launcher state without silently repairing settings", () => {
  assert.deepEqual(reconcileClaudeSetupState("outdated"), {
    claudeSetupComplete: false,
    claudeSetupOutdated: true,
  });
  assert.deepEqual(reconcileClaudeSetupState("current"), {
    claudeSetupComplete: true,
    claudeSetupOutdated: false,
  });
  assert.deepEqual(reconcileClaudeSetupState("missing"), {
    claudeSetupComplete: false,
    claudeSetupOutdated: false,
  });
});

test("wires actual hook status into snapshot and the reinstall action", () => {
  const main = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "../src/App.tsx"), "utf8");

  assert.match(main, /runtimeHost\?\.claudeIntegrationStatus\(\)/);
  assert.match(main, /stateStore\.update\(claude\)/);
  assert.match(app, /claudeSetupComplete \|\| snapshot\.state\.claudeSetupOutdated/);
});
