const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(launcherRoot, "src", "App.tsx"), "utf8");
const settingsSource = fs.readFileSync(path.join(launcherRoot, "src", "settings-surface.tsx"), "utf8");
const sharedSource = fs.readFileSync(path.join(launcherRoot, "src", "app-shared.tsx"), "utf8");
const stylesSource = fs.readFileSync(path.join(launcherRoot, "src", "styles.css"), "utf8");
const electronMain = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");
const browserHostSource = fs.readFileSync(path.join(launcherRoot, "electron", "browser-host.cjs"), "utf8");
const preloadSource = fs.readFileSync(path.join(launcherRoot, "electron", "preload.cjs"), "utf8");

test("Bigger Context waits for startup and route recovery without invalidating healthy setup", async () => {
  const vm = require("node:vm");
  for (const fails of [false, true]) {
    const startupAuthenticationRefresh = new Promise(() => {});
    let completeRuntime;
    const runtimeReady = new Promise(resolve => { completeRuntime = resolve; });
    let reachedStartup;
    const startupReached = new Promise(resolve => { reachedStartup = resolve; });
    let finishRuntimeStartup;
    const runtimeStartup = new Promise(resolve => { finishRuntimeStartup = resolve; });
    let startupSettled = false;
    const calls = [];
    const handlers = new Map();
    const config = { mode: "full", experimentalBiggerContext: false };
    const state = { coreSetupComplete: true, codexCatalogVerified: true };
    const stateStore = { read: () => state, update: patch => Object.assign(state, patch) };
    const logger = { info() {}, error() {}, warn() {} };
    const context = vm.createContext({
      runtimeStartup, finishRuntimeStartup: () => { startupSettled = true; finishRuntimeStartup(); },
      startupAuthenticationRefresh, logger, stateStore, IS_DEV_PROFILE: false, browserHost: null,
      ipcMain: { on() {} }, registerLoggedIpc: (_ipc, _logger, channel, handler) => handlers.set(channel, handler),
      send() {}, publishOperation() {}, startCatalogVerificationMonitor() {}, stopCatalogVerificationMonitor() {},
      syncBrowserPreferences() {},
      restoreCodexRouteAfterRuntimeFailure: async () => { calls.push("recovery"); return {}; },
      limitsController: { snapshot: () => ({ enabled: false }) },
      runtimeSupervisor: {
        readConfig: () => config,
        startIfConfigured: async () => {
          calls.push("startup");
          reachedStartup();
          await runtimeReady;
          if (fails) throw new Error("actual startup failure");
          return { status: "ready" };
        },
      },
      runtimeHost: {
        currentOperation: () => null,
        upgradeManagedRuntime: async () => ({ updated: false }),
        runtimeConfigSnapshot: () => ({ configured: true, config }),
        bridgeStatus: async () => ({ installed: false }),
        connectBridgeRoute: async () => ({ changed: false }),
        setBiggerContext: async enabled => {
          assert.equal(startupSettled, true, "settings must wait through startup recovery too");
          calls.push("setting");
          config.experimentalBiggerContext = enabled;
          return { enabled };
        },
      },
    });
    vm.runInContext(electronMain.slice(electronMain.indexOf("function syncBrowserPreferences("), electronMain.indexOf("async function requestQuit("))
      + "\nregisterIpc({ logger, stateStore });", context);
    const start = electronMain.indexOf("} else void (async () => {");
    vm.runInContext(electronMain.slice(start + "} else ".length, electronMain.indexOf('  app.on("before-quit"', start)), context);
    const setting = handlers.get("launcher:bigger-context")({}, true);
    // Runtime startup proceeds even if the browser session check never completes.
    // Settings still wait for runtime readiness, and read-only UI stays usable.
    assert.equal((await handlers.get("launcher:limits")()).enabled, false);
    await startupReached;
    assert.deepEqual(calls, ["startup"]);
    completeRuntime();
    await setting;
    assert.deepEqual(calls, fails ? ["startup", "recovery", "setting"] : ["startup", "setting"]);
    assert.equal(state.experimentalBiggerContext, true);
    assert.equal(state.coreSetupComplete, !fails, "only a real startup failure may invalidate setup");
  }
});

test("embedded ChatGPT is measured only after its animated surface mounts", () => {
  assert.match(appSource, /const \[browserSlot, setBrowserSlot\] = useState<HTMLDivElement \| null>\(null\)/);
  assert.match(appSource, /setBrowserSurfaceActive\(browserSurfaceActive\)\.then\(\(\) => \{/);
  assert.match(appSource, /observer\.observe\(browserSlot\)/);
  assert.match(appSource, /ref=\{browserSlotRef\}/);
});

test("native clicks reach browser tabs instead of the window drag region", () => {
  assert.match(appSource, /draggable=\{surface !== "browser"\}/);
  assert.match(appSource, /className=\{`app-titlebar\$\{draggable \? " draggable" : ""\}`\}/);
  assert.match(stylesSource, /\.browser-tab\s*\{[^}]*-webkit-app-region:\s*no-drag;/s);
  assert.match(appSource, /className="browser-tab-drag draggable"/);
});

test("embedded ChatGPT cannot turn its page header into a native window drag region", () => {
  const viewportCss = browserHostSource.match(/const CHATGPT_VIEWPORT_CSS = `([\s\S]*?)`;/)?.[1];
  assert.ok(viewportCss);
  assert.match(viewportCss, /\*\s*\{[^}]*-webkit-app-region:\s*no-drag\s*!important;/s);
  assert.match(browserHostSource, /contents\.insertCSS\(CHATGPT_VIEWPORT_CSS\)/);
  assert.match(browserHostSource, /markTurnTabSurface\(this, tab, CHATGPT_VIEWPORT_CSS\)/);
});

test("renderer zoom scales the shell without moving or zooming the native ChatGPT surface", () => {
  assert.match(
    electronMain,
    /browserHost\?\.setBounds\(validateBounds\(bounds\), event\.sender\.getZoomFactor\(\)\)/,
  );
  assert.match(browserHostSource, /this\.bindShellZoomShortcuts\(this\.window\.webContents\)/);
  assert.match(browserHostSource, /contents\.setZoomLevel\(next\)/);
  assert.match(appSource, /api!\.zoomBrowser\(action\)/);
});

test("closing the launcher follows the persisted background-runtime preference", () => {
  assert.match(
    electronMain,
    /if \(stateStore\.read\(\)\.keepRunningOnClose && tray\) window\.hide\(\);\s*else void requestQuit\(\);/,
  );
  assert.match(settingsSource, /setPreference\("keepRunningOnClose", checked\)/);
});

test("normal shutdown persists the ChatGPT session before closing browser views", () => {
  assert.match(
    electronMain,
    /runtimeSupervisor\?\.shutdown\(\{ cancelActiveTurns: true, force: true \}\)/,
  );
  const persist = electronMain.indexOf("await browserHost?.persistSession()");
  const destroy = electronMain.indexOf("browserHost?.destroy()", persist);
  assert.ok(persist >= 0, "shutdown must persist the ChatGPT session");
  assert.ok(destroy > persist, "browser views must close only after session persistence completes");
});

test("packaged runtime is verified before launcher browser surfaces can bind ports", () => {
  const start = electronMain.indexOf("async function start()");
  const runtimeValidation = electronMain.indexOf("installedRuntimeRoot = runtimeRootProvider();", start);
  const cdpPortAllocation = electronMain.indexOf("cdpPort = await findFreePort();", start);
  const windowCreation = electronMain.indexOf("mainWindow = createWindow({", start);
  const controlServerStart = electronMain.indexOf("browserControl = await new BrowserControlServer({", start);
  const browserReady = electronMain.indexOf("await browserHost.ready();", start);

  assert.ok(runtimeValidation > start, "startup must eagerly verify the packaged runtime");
  for (const [surface, position] of [
    ["CDP port allocation", cdpPortAllocation],
    ["launcher window", windowCreation],
    ["browser control server", controlServerStart],
    ["embedded browser", browserReady],
  ]) {
    assert.ok(position > runtimeValidation, `${surface} must start only after runtime verification`);
  }
});

test("DEV launcher exposes its profile and supervises only its Full-mode MCP runtime", () => {
  assert.match(electronMain, /profile:\s*LAUNCHER_PROFILE\.kind/);
  assert.match(electronMain, /if \(IS_DEV_PROFILE\) \{[\s\S]*?config\?\.mode === "full"[\s\S]*?runtimeSupervisor\.startIfConfigured\(\)[\s\S]*?\} else void \(async \(\) => \{/);
  assert.match(electronMain, /await runtimeSupervisor\?\.shutdown\(\{ cancelActiveTurns: true, force: true \}\)/);
  assert.match(electronMain, /packaged:\s*app\.isPackaged && !IS_DEV_PROFILE/);
  assert.match(electronMain, /IS_DEV_PROFILE && !stateStore\.read\(\)\.onboardingComplete/);
  assert.match(electronMain, /onboardingComplete:\s*true,[\s\S]*?autoStart:\s*false/);
  assert.match(appSource, /snapshot\.profile === "development"/);
  assert.match(appSource, /data-profile=\{snapshot\.profile\}/);
  assert.match(settingsSource, /<SettingRow body=\{snapshot\.state\.browserInteractionMode === "manual" \? copy\.manualBiggerContextBody\s*: copy\.biggerContextBody\} label=\{copy\.biggerContext\}>/);
  assert.match(settingsSource, /api!\.setBiggerContext\(enabled\)/);
  assert.match(electronMain, /runtimeHost\.setBiggerContext\(enabled === true\)/);
  assert.match(settingsSource, /api!\.setExperimentalNoAutoCompact\(enabled\)/);
  assert.match(electronMain, /runtimeHost\.setExperimentalNoAutoCompact\(enabled === true\)/);
  assert.doesNotMatch(electronMain, /IS_DEV_PROFILE && key === "experimentalBiggerContext"/);
});

test("the renderer bridge switch reaches the fail-closed runtime route", () => {
  assert.match(settingsSource, /api!\.setBridgeEnabled\(enabled\)/);
  assert.match(electronMain, /runtimeHost\.setBridgeEnabled\(enabled === true\)/);
  assert.match(electronMain, /codexRestartRequired:\s*true/);
});

test("macOS passkey sign-in is additive to the unchanged embedded login action", () => {
  assert.match(appSource, /onAction=\{openLogin\}/);
  assert.match(appSource, /<BrowserSurface[\s\S]*?operation=\{operation\}[\s\S]*?platform=\{snapshot\.platform\}/);
  assert.match(appSource, /platform === "darwin" && browser\?\.authenticated !== true[\s\S]*?className="toolbar-text-button"[\s\S]*?copy\.passkeySignIn/);
  assert.match(appSource, /className="browser-empty-actions"[\s\S]*?copy\.passkeySignIn/);
  assert.match(appSource, /snapshot\.platform === "darwin"[\s\S]*?openPasskeyLogin/);
  assert.match(appSource, /passkeyWaiting \? continuePasskeyLogin : openPasskeyLogin/);
  assert.match(preloadSource, /openPasskeyLogin:[\s\S]*?launcher:browser-passkey-login/);
  assert.match(preloadSource, /continuePasskeyLogin:[\s\S]*?launcher:browser-passkey-login-continue/);
  assert.match(electronMain, /launcher:browser-passkey-login[\s\S]*?browserHost\.openPasskeyLogin\(\)/);
  assert.match(electronMain, /loginWithPasskey: onProgress => runtimeHost\.capturePasskeyLogin\(onProgress\)/);
  assert.match(browserHostSource, /await this\.waitForAuthenticated\(60_000\)[\s\S]*?runSessionInspection\(false\)/);
});

test("MCP connection requires a verified Codex catalog or current Claude setup", () => {
  assert.match(
    appSource,
    /manualInteraction \|\| configuringInactiveMode \|\| hasVerifiedClientIntegration\(snapshot\.state\)\s+\? copy\.mcpStepTwoHint : copy\.mcpCatalogRequired/,
  );
  assert.match(appSource, /\|\| \(!manualInteraction && !configuringInactiveMode && !hasVerifiedClientIntegration\(snapshot\.state\)\)/);
  const body = appSource.match(/function hasVerifiedClientIntegration\(state: LauncherState\): boolean \{([\s\S]*?)\n\}/)[1];
  const verified = new Function("state", body);
  assert.equal(verified({ codexCatalogVerified: true, claudeSetupComplete: false }), true);
  assert.equal(verified({ codexCatalogVerified: false, claudeSetupComplete: true }), true);
  assert.equal(verified({ codexCatalogVerified: false, claudeSetupComplete: false }), false);
  assert.equal(verified({}), false);
  assert.equal(verified({ codexCatalogVerified: "true", claudeSetupComplete: "true" }), false);
});

test("MCP navigation remains locked while an operation is active", () => {
  assert.match(appSource, /<McpSurface[\s\S]*?operation=\{operation\}/);
  assert.match(appSource, /const busy = localBusy \|\| operation\?\.status === "running"/);
  assert.match(appSource, /const safeMove = async \(next: number\) => \{\s*if \(busy\) return;/);
  assert.match(appSource, /disabled=\{busy \|\| index > step\}/);
});

test("failed doctor reports retain every failed check", () => {
  assert.match(
    sharedSource,
    /report\.ok\s*\?\s*report\.checks\.slice\(-6\)\s*:\s*report\.checks\.filter\(\(check\) => check\.status !== "ok"\)/,
  );
  assert.match(sharedSource, /visibleChecks\.map\(\(check\) =>/);
});

test("launcher shares only privacy-safe exported diagnostics", () => {
  assert.match(appSource, /api!\.exportLogs\(\)/);
  assert.match(preloadSource, /exportLogs:[\s\S]*?launcher:export-logs/);
  assert.match(electronMain, /launcher:export-logs[\s\S]*?showSaveDialog[\s\S]*?exportSanitizedLogs/);
  assert.doesNotMatch(preloadSource, /launcher:open-logs/);
  assert.doesNotMatch(electronMain, /launcher:open-logs/);
});

test("MCP verification failures stay inside the structured setup report", () => {
  assert.match(appSource, /next\.operation\.name !== "mcp-verification"/);
  assert.match(appSource, /next\.name !== "mcp-verification"/);
  assert.match(electronMain, /Finish the active Codex task before verifying the ChatGPT connector/);
  assert.match(electronMain, /report\.checks\.filter\(\(check\) => check\.id !== "connector"\)/);
  assert.match(electronMain, /mcp\.verification_requested/);
  assert.match(electronMain, /launcherFocused:\s*mainWindow\?\.isFocused\(\) === true/);
  assert.match(electronMain, /rendererFocused:\s*event\.sender\.isFocused\(\)/);
});

test("MCP verification proves runtime health before checking the connector", () => {
  const start = electronMain.indexOf('handle("launcher:mcp-verify"');
  const end = electronMain.indexOf('handle("launcher:doctor"', start);
  const handler = electronMain.slice(start, end);

  assert.ok(start >= 0 && end > start, "MCP verification handler must remain registered");
  assert.match(
    handler,
    /Checking local runtime[\s\S]*?await runtimeHost\.doctor\(\)[\s\S]*?if \(!report\.ok\)[\s\S]*?return report;[\s\S]*?Checking ChatGPT connector[\s\S]*?await browserHost\.verifyConnector/,
  );
  assert.match(handler, /publishOperation\(\{ name: operationName, status: "completed"/);
  assert.match(appSource, /const verified = !configuringInactiveMode && snapshot\.state\.mcpSetupComplete === true/);
  assert.match(appSource, /onClick=\{\(\) => void \(verified \? onDone\(\) : verify\(\)\)\}/);
  assert.match(appSource, /operation\?\.name === "mcp-verification"/);
  assert.match(appSource, /index < step \|\| \(index === 2 && verified\) \? " is-complete"/);
});

test("saved ChatGPT authentication refresh does not gate local runtime startup", () => {
  assert.match(electronMain, /browserHost\.refreshAuthentication\(\)/);
  const productionStartup = electronMain.indexOf("} else void (async () => {");
  const refreshBarrier = electronMain.indexOf("await startupAuthenticationRefresh", productionStartup);
  const upgrade = electronMain.indexOf("runtimeHost.upgradeManagedRuntime()", productionStartup);
  const runtimeStart = electronMain.indexOf("runtimeSupervisor.startIfConfigured()", upgrade);
  const routeConnect = electronMain.indexOf("runtimeHost.connectBridgeRoute({ recoveryOnly: true })", runtimeStart);
  assert.equal(refreshBarrier, -1, "the bridge must start while ChatGPT is signed out or unavailable");
  assert.ok(upgrade > productionStartup);
  assert.ok(runtimeStart > upgrade, "configured runtime must start after any upgrade");
  assert.ok(routeConnect > runtimeStart, "Codex route must connect only after the runtime is healthy");
  assert.match(appSource, /browser\?\.status === "loading" \? copy\.checkingSignIn/);
});

test("completed model setup remains a repeatable capability probe", () => {
  const setupStart = appSource.indexOf("<SetupRow", appSource.indexOf("onAction={installCodex}") - 700);
  const setupEnd = appSource.indexOf("/>", appSource.indexOf("onAction={installCodex}"));
  const integrationSetup = appSource.slice(setupStart, setupEnd);
  assert.match(integrationSetup, /onAction=\{installCodex\}/);
  assert.match(integrationSetup, /onSecondaryAction=\{devProfile \? undefined : installClaude\}/);
  assert.match(integrationSetup, /\brepeatable\b/);
  assert.match(appSource, /complete && !repeatable/);
  assert.match(
    electronMain,
    /!setupState\.coreSetupComplete[\s\S]*?smokePassedThisSession[\s\S]*?smokePassedForCurrentVersion\(setupState\)/,
  );
});

test("session reminders expose dismissal and a real storage-clearing logout", () => {
  assert.match(electronMain, /sessionRefreshReminderAt:\s*nextSessionRefreshReminderAt\(\)/);
  assert.match(electronMain, /launcher:session-reminder-dismiss/);
  assert.match(electronMain, /launcher:browser-logout[\s\S]*?browserHost\.logout\(\)/);
  assert.match(preloadSource, /dismissSessionReminder:[\s\S]*?launcher:session-reminder-dismiss/);
  assert.match(preloadSource, /logoutChatGpt:[\s\S]*?launcher:browser-logout/);
  assert.match(browserHostSource, /session\.clearStorageData\(\)/);
});

test("setup preserves session-check failures and never installs without verified authentication", async () => {
  const vm = require("node:vm");
  const source = electronMain.slice(
    electronMain.indexOf("  const setupIntegration = async"),
    electronMain.indexOf('handle("launcher:setup-mcp",'),
  );
  for (const dev of [false, true]) {
    let setup;
    let installs = 0;
    let browser = { authenticated: false, status: "error", message: "ChatGPT session verification failed (HTTP 503)." };
    const state = { browserInteractionMode: "automatic", coreSetupComplete: false, codexSetupComplete: false };
    const run = async () => { installs++; return { mode: "browser-only", stdout: "" }; };
    vm.runInNewContext(source, {
      handle: (name, handler) => { if (name === "launcher:setup-codex") setup = handler; }, IS_DEV_PROFILE: dev,
      stateStore: { read: () => state, update() {} },
      browserHost: { probeAuthentication: async () => browser, returnToIdle: async () => {} },
      runtimeHost: { setupCore: run, setupDevCore: run, runtimeConfigSnapshot: () => ({ config: {} }) },
      smokePassedThisSession: true, smokePassedForCurrentVersion: () => true,
      send() {}, startCatalogVerificationMonitor() {}, logger: { warn() {} },
    });
    await assert.rejects(setup, error => error.message === browser.message);
    assert.equal(installs, 0);
    browser = { authenticated: false, status: "signed-out", message: "Sign in to ChatGPT" };
    await assert.rejects(setup, /Sign in to/);
    assert.equal(installs, 0);
    browser = { authenticated: true, status: "ready", message: "ChatGPT is ready" };
    assert.equal((await setup()).ok, true);
    assert.equal(installs, 1);
  }
});

test("startup failure stays visible on another launch and Retry exits the failed instance", async () => {
  const vm = require("node:vm");
  const source = electronMain.slice(electronMain.indexOf("function showMainWindow()"), electronMain.indexOf("async function openWebUrl"))
    + electronMain.slice(electronMain.indexOf("void start().catch("));
  const events = [];
  let visible = false;
  let answer;
  const dialogOpened = new Promise(resolve => {
    answer = { opened: resolve };
  });
  const window = { isDestroyed: () => false, isMinimized: () => false,
    show: () => { visible = true; }, focus() {}, };
  const sandbox = {
    mainWindow: window, mainWindowReadyToShow: false, mainWindowShowRequested: false,
    startupFailed: false, quitting: false,
    browserHost: { destroy: () => events.push("destroy") },
    browserControl: { close: async () => events.push("control closed") },
    start: async () => { throw new Error("Browser idle document did not commit within 10000ms"); },
    app: { getPath: () => "/unused", whenReady: async () => {},
      relaunch: options => events.push(["relaunch", options.args]), exit: code => events.push(["exit", code]) },
    fs: { appendFileSync() {} }, path,
    createStateStore: () => ({ read: () => ({ language: "ko" }) }),
    nativeCopyFor: language => {
      assert.equal(language, "ko");
      return { startupTitle: "시작 오류", startupDetail: "다시 시작", startupCleanupFailed: "정리 실패", retry: "다시 시도", quit: "종료" };
    },
    launchEnvironment: { CODEX_CHATGPT_WEB_HOME: undefined, CODEX_HOME: "original-codex-home" },
    process: { argv: ["launcher", "--hidden"], env: { CODEX_CHATGPT_WEB_HOME: "dev-home", CODEX_HOME: "dev-codex-home" } },
    dialog: {
      showMessageBox: (owner, options) => {
        assert.equal(options.title, "시작 오류");
        assert.deepEqual(Array.from(options.buttons), ["다시 시도", "종료"]);
        events.push(["dialog", owner === window, options.message]);
        answer.opened();
        return new Promise(resolve => { answer.resolve = resolve; });
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  await dialogOpened;
  assert.equal(visible, true, "the failed startup must expose its error owner without renderer readiness");
  assert.deepEqual(events.slice(0, 2), ["destroy", "control closed"]);
  visible = false;
  sandbox.showMainWindow();
  assert.equal(visible, true, "a second launch must restore the existing startup error window");
  assert.equal(events.some(event => Array.isArray(event) && event[0] === "exit"), false);
  answer.resolve({ response: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.at(-2)[0], "relaunch");
  assert.deepEqual(Array.from(events.at(-2)[1]), []);
  assert.deepEqual(events.at(-1), ["exit", 1]);
  assert.deepEqual(sandbox.process.env, { CODEX_HOME: "original-codex-home" });
});

test("catalog verification reports a failed request instead of requesting another restart, then recovers", async () => {
  const vm = require("node:vm");
  const start = electronMain.indexOf("function startCatalogVerificationMonitor(");
  const end = electronMain.indexOf("\nfunction ", start + 1);
  const source = electronMain.slice(start, end);
  const state = { coreSetupComplete: true, codexSetupComplete: true, codexCatalogVerified: false, codexRestartRequired: true, language: "en" };
  const operations = [];
  const events = [];
  let tick;
  let payload = { pid: 10, successful_model_catalog_requests: 0, model_catalog_requests: 0, last_model_catalog_result: null };
  vm.runInNewContext(source + "\nconst publishOperation = op => { lastOperation = op; recordOperation(op); };\nstartCatalogVerificationMonitor({ logger, stateStore });", {
    catalogVerificationInFlight: false, catalogVerificationTimer: null, lastOperation: null,
    stopCatalogVerificationMonitor() {},
    runtimeSupervisor: { readConfig: () => ({}), proxyHealthPayload: async () => payload },
    stateStore: { read: () => state, update: patch => Object.assign(state, patch) },
    setInterval: callback => { tick = callback; return { unref() {} }; },
    logger: { info: (...args) => events.push(args), warn: (...args) => events.push(args), debug() {} },
    send() {}, recordOperation: op => operations.push(op),
    nativeCopyFor: () => ({ catalogFailure: "Catalog failed (HTTP {status}; {reason}).", catalogReady: "Loaded." }),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(operations.length, 0);
  assert.equal(state.codexRestartRequired, true);
  payload = { ...payload, model_catalog_requests: 1, last_model_catalog_result: {
    request: 1, at: "2026-09-16T10:00:00Z", status: 502, failure: { stage: "transport", code: "UnsupportedProxyProtocol" },
  } };
  await tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.codexCatalogVerified, false);
  assert.equal(state.codexRestartRequired, false);
  assert.equal(operations[0]?.status, "failed");
  assert.match(operations[0].message, /502.*UnsupportedProxyProtocol/);
  await tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(operations.length, 1, "polling must not repeat the same failure");
  payload = { ...payload, successful_model_catalog_requests: 1, last_successful_model_catalog_request_at: "2026-09-16T10:01:00Z" };
  await tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.codexCatalogVerified, true);
  assert.equal(state.codexRestartRequired, false);
  assert.ok(events.some(([event]) => event === "codex.model_catalog_verified"));
  assert.equal(operations.at(-1)?.status, "completed");
});

test("browser preference IPC commits only after setup succeeds and refuses active browser work", async () => {
  const vm = require("node:vm");
  for (const [property, method, channel, nextChannel] of [
    ["experimentalFreshConversationPerTurn", "setFreshConversationPerTurn", "launcher:fresh-conversation-per-turn", "launcher:use-saved-chats"],
    ["useSavedChats", "setUseSavedChats", "launcher:use-saved-chats", "launcher:auto-approve-tool-calls"],
    ["autoApproveToolCalls", "setAutoApproveToolCalls", "launcher:auto-approve-tool-calls", "launcher:set-preference"],
  ]) {
    const source = electronMain.slice(
      electronMain.indexOf(`handle("${channel}",`),
      electronMain.indexOf(`handle("${nextChannel}",`),
    );
    const state = { experimentalFreshConversationPerTurn: false, useSavedChats: false, autoApproveToolCalls: false };
    const config = { experimentalFreshConversationPerTurn: false, useSavedChats: false, autoApproveToolCalls: false };
    const events = [];
    let handler, finishSetup, setupFailure, calls = 0;
    const browserHost = { activeTraceId: "running-turn", currentOperation: () => null, turnTabs: new Map() };
    const syncSource = electronMain.slice(electronMain.indexOf("function syncBrowserPreferences("), electronMain.indexOf("function registerIpc("));
    vm.runInNewContext(syncSource + source, {
      handle: (_channel, callback) => { handler = callback; }, browserHost,
      releaseRetainedConversation: require("../electron/retained-turn-release.cjs").releaseRetainedConversation,
      runtimeHost: { currentOperation: () => null, runtimeConfigSnapshot: () => ({ config }), [method]: async enabled => {
        calls++;
        if (setupFailure) throw setupFailure;
        await new Promise(resolve => { finishSetup = resolve; });
        config[property] = enabled;
        return { enabled };
      } },
      stateStore: { read: () => ({ ...state }), update: patch => Object.assign(state, patch) },
      send: (channel, value) => events.push({ channel, value: { ...value } }),
    });
    await assert.rejects(() => handler(null, true), /Finish or cancel active ChatGPT turns/);
    browserHost.activeTraceId = null;
    browserHost.currentOperation = () => "browser-smoke";
    await assert.rejects(() => handler(null, true), /Finish or cancel active ChatGPT turns/);
    assert.equal(calls, 0);
    browserHost.currentOperation = () => null;
    let api;
    vm.runInNewContext(preloadSource, { require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { invoke: (actualChannel, enabled) => {
        assert.equal(actualChannel, channel);
        return handler(null, enabled);
      } },
    }) });
    const changing = api[method](true);
    assert.equal(state[property], false);
    assert.equal(events.length, 0);
    finishSetup();
    assert.equal((await changing)[property], true);
    assert.equal(events.length, 1);
    assert.equal(events[0].channel, "launcher:state-changed");
    setupFailure = new Error("synthetic setup rollback");
    await assert.rejects(() => api[method](false), /synthetic setup rollback/);
    assert.equal(state[property], true);
    assert.equal(events.length, 1);
  }
});

test("fresh-conversation snapshot uses runtime configuration and manual mode clears the preference", async () => {
  const vm = require("node:vm");
  const handlers = new Map();
  const state = { browserInteractionMode: "automatic", experimentalFreshConversationPerTurn: false };
  let config = { browserInteractionMode: "automatic", experimentalFreshConversationPerTurn: true };
  const runtimeHost = {
    currentOperation: () => null,
    runtimeConfigSnapshot: () => ({ config }), browserConnectorName: () => "Codex Native2",
    setupConnectorName: () => "Codex Native2", mcpCredentialsConfigured: () => true,
    setBrowserInteractionMode: async mode => { config.browserInteractionMode = mode; if (mode === "manual") config.experimentalFreshConversationPerTurn = false; return { configured: true }; },
    claudeIntegrationStatus: () => "missing",
  };
  const sandbox = {
    handle: (name, handler) => handlers.set(name, handler), runtimeHost,
    reconcileClaudeSetupState: () => ({ claudeSetupComplete: false, claudeSetupOutdated: false }),
    releaseRetainedConversation: require("../electron/retained-turn-release.cjs").releaseRetainedConversation,
    stateStore: { read: () => ({ ...state }), update: patch => Object.assign(state, patch) },
    browserHost: { activeTraceId: null, turnTabs: new Map(), currentOperation: () => null, snapshot: () => ({}),
      withInteractionModeChange: async (_mode, action) => action() },
    validateBrowserInteractionMode: mode => mode, IS_DEV_PROFILE: false, send() {}, startCatalogVerificationMonitor() {},
    LAUNCHER_PROFILE: { kind: "production", codexHome: "/fixture/codex" }, CORE_HOME: "/fixture/core",
    launcherUserData: "/fixture/launcher", logger: { recent: () => [] },
    GITHUB_URL: "", X_URL: "", CONNECTORS_URL: "", TUNNELS_URL: "", KEYS_URL: "",
    process: { platform: "darwin" }, app: { isPackaged: false, getVersion: () => "test" },
    smokePassedThisSession: false, smokePassedForCurrentVersion: () => false, lastOperation: null, updateController: null,
  };
  vm.runInNewContext(electronMain.slice(electronMain.indexOf("function syncBrowserPreferences("), electronMain.indexOf("function registerIpc(")) +
    electronMain.slice(electronMain.indexOf('handle("launcher:snapshot",'),
    electronMain.indexOf('handle("launcher:set-language",')) +
    electronMain.slice(electronMain.indexOf('handle("launcher:browser-interaction-mode",'),
    electronMain.indexOf('handle("launcher:uninstall-integration",')), sandbox);
  const snapshot = handlers.get("launcher:snapshot");
  assert.equal((await snapshot()).state.experimentalFreshConversationPerTurn, true);
  assert.equal(state.experimentalFreshConversationPerTurn, true, "snapshot synchronizes a CLI configuration change");
  const changeMode = handlers.get("launcher:browser-interaction-mode");
  for (const mode of ["manual", "automatic"]) {
    const changed = await changeMode(null, mode);
    assert.equal(changed.state.experimentalFreshConversationPerTurn, false);
    assert.equal((await snapshot()).state.experimentalFreshConversationPerTurn, false);
  }
  config = {};
  assert.equal((await snapshot()).state.experimentalFreshConversationPerTurn, false);
  assert.equal((await snapshot()).state.biggerContextAvailable, false);
  config.solAvailable = true;
  assert.equal((await snapshot()).state.biggerContextAvailable, true);
  config.solAvailable = false;
  assert.equal((await snapshot()).state.biggerContextAvailable, true);
});

test("changing Bigger Context retires ready automatic chats before a previous mode can reuse them", () => {
  const vm = require("node:vm");
  const state = { experimentalBiggerContext: false, experimentalFreshConversationPerTurn: false,
    useSavedChats: false, autoApproveToolCalls: false, biggerContextAvailable: true };
  const tabs = new Map([
    ["old", { status: "ready", conversationKey: "old-luna", interactionMode: "automatic" }],
    ["active", { status: "running", conversationKey: "running", interactionMode: "automatic" }],
    ["manual", { status: "ready", conversationKey: "manual", interactionMode: "manual" }],
  ]);
  const released = [];
  const context = vm.createContext({
    runtimeHost: { currentOperation: () => null }, browserHost: { turnTabs: tabs },
    releaseRetainedConversation: (_host, key) => { released.push(key); tabs.delete("old"); }, send() {},
  });
  vm.runInContext(electronMain.slice(electronMain.indexOf("function syncBrowserPreferences("), electronMain.indexOf("function registerIpc(")), context);
  const store = { read: () => state, update: patch => Object.assign(state, patch) };
  context.syncBrowserPreferences(store, { solAvailable: false, experimentalBiggerContext: true });
  assert.deepEqual(released, ["old-luna"]);
  assert.equal(state.experimentalBiggerContext, true);
  assert.equal(tabs.has("active"), true);
  assert.equal(tabs.has("manual"), true);
  context.syncBrowserPreferences(store, { solAvailable: false, experimentalBiggerContext: true });
  assert.deepEqual(released, ["old-luna"]);
});

test("fresh-conversation control is translated and enforces Original automatic mode", async () => {
  const ts = require("typescript");
  const vm = require("node:vm");
  const transpile = (source, fileName) => ts.transpileModule(source, {
    fileName, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React, jsxFactory: "element" },
  }).outputText;
  const load = file => {
    const module = { exports: {} };
    vm.runInNewContext(transpile(fs.readFileSync(file, "utf8"), file), {
      module, exports: module.exports, require: name => load(path.resolve(path.dirname(file), name + ".ts")),
    });
    return module.exports;
  };
  const translated = load(path.join(launcherRoot, "src/i18n.ts"));
  const contextMode = load(path.join(launcherRoot, "src/context-mode.ts"));
  let invocation, saved;
  const sandbox = {
    exports: {}, React: { Fragment: "Fragment" },
    element: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: value => [value, () => {}], useEffect() {},
    api: {
      setFreshConversationPerTurn: async enabled => { invocation = enabled; return { experimentalFreshConversationPerTurn: enabled }; },
      setAutoApproveToolCalls: async enabled => { invocation = enabled; return { autoApproveToolCalls: enabled }; },
      setBiggerContext: async enabled => { invocation = enabled; return { experimentalBiggerContext: enabled }; },
    },
    messageOf: String, platformLabel: String, languages: require("../electron/languages.json"),
    biggerContextSwitchState: contextMode.biggerContextSwitchState,
  };
  for (const name of ["ContentSurface", "SectionHeading", "NoticeRow", "Icon", "DoctorSummary", "BrandMark", "ApiAccessCard", "PrimaryButton", "SecondaryButton"]) sandbox[name] = name;
  const settings = fs.readFileSync(path.join(launcherRoot, "src/settings-surface.tsx"), "utf8");
  vm.runInNewContext(transpile(settings.slice(settings.indexOf("export function SettingsSurface(")), "settings.tsx"), sandbox);
  const render = sandbox.exports.SettingsSurface;
  const visit = tree => Array.isArray(tree) ? tree.flatMap(visit) : tree && typeof tree === "object"
    ? [tree, ...visit(tree.children ?? [])] : [];
  for (const language of Object.keys(require("../electron/languages.json"))) {
    const copy = translated.copyFor(language);
    for (const key of ["freshConversation", "freshConversationBody", "manualFreshConversationUnavailable"]) {
      assert.equal(typeof copy[key], "string");
      assert.ok(copy[key].length > 10);
    }
    for (const [mode, configured, enabled, enhanced] of [
      ["automatic", true, false, false], ["automatic", true, true, false],
      ["manual", true, true, false], ["automatic", false, false, false], ["automatic", true, true, true],
    ]) {
      const tree = render({ copy, devProfile: false, language, configureInteractionMode() {}, setError() {}, browser: null,
        snapshot: {
          connectorNames: { automatic: "Codex Native2", manual: "Codex Zero Risk" },
          state: { browserInteractionMode: mode, coreSetupComplete: configured, experimentalFreshConversationPerTurn: enabled, useEnhancedWebSessionMode: enhanced },
        },
        updateState: value => { saved = value; },
      });
      const row = visit(tree).find(node => node.type?.name === "SettingRow" && node.props.label === copy.freshConversation);
      assert.ok(row);
      assert.equal(row.props.body, mode === "manual" || enhanced ? copy.manualFreshConversationUnavailable : copy.freshConversationBody);
      const control = visit(row).find(node => node.type?.name === "Switch");
      assert.equal(control.props.checked, enabled && mode === "automatic" && !enhanced);
      assert.equal(control.props.disabled, mode === "manual" || !configured || enhanced);
      if (!control.props.disabled) {
        control.props.onChange(true);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(invocation, true);
        assert.equal(saved.experimentalFreshConversationPerTurn, true);
      }
    }
    assert.ok(copy.biggerContextBody.length > 20);
    for (const available of [undefined, false, true]) {
      const tree = render({ copy, devProfile: false, language, configureInteractionMode() {}, setError() {}, browser: null,
        snapshot: { connectorNames: { automatic: "Codex Native2", manual: "Codex Zero Risk" },
          state: { browserInteractionMode: "automatic", coreSetupComplete: true,
            useEnhancedWebSessionMode: false, experimentalBiggerContext: false, biggerContextAvailable: available } },
        updateState: value => { saved = value; },
      });
      const row = visit(tree).find(node => node.type?.name === "SettingRow" && node.props.label === copy.biggerContext);
      assert.ok(row);
      assert.equal(row.props.body, copy.biggerContextBody);
      const control = visit(row).find(node => node.type?.name === "Switch");
      assert.equal(control.props.checked, false);
      assert.equal(control.props.disabled, available !== true);
      if (!control.props.disabled) {
        control.props.onChange(true);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(invocation, true);
        assert.equal(saved.experimentalBiggerContext, true);
      }
    }
    for (const key of ["autoApproveTools", "autoApproveToolsBody", "manualAutoApproveUnavailable", "toolApprovalNeeded", "toolApprovalPendingBody"]) {
      assert.equal(typeof copy[key], "string");
      assert.ok(copy[key].length > 5);
    }
    for (const [mode, configured, enabled] of [["automatic", true, false], ["automatic", true, true], ["manual", true, true], ["automatic", false, false]]) {
      const tree = render({ copy, devProfile: false, language, configureInteractionMode() {}, setError() {}, browser: null,
        snapshot: { connectorNames: { automatic: "Codex Native2", manual: "Codex Zero Risk" },
          state: { browserInteractionMode: mode, coreSetupComplete: configured, autoApproveToolCalls: enabled } },
        updateState: value => { saved = value; },
      });
      const row = visit(tree).find(node => node.type?.name === "SettingRow" && node.props.label === copy.autoApproveTools);
      assert.ok(row);
      assert.equal(row.props.body, mode === "manual" ? copy.manualAutoApproveUnavailable : copy.autoApproveToolsBody);
      const control = visit(row).find(node => node.type?.name === "Switch");
      assert.equal(control.props.checked, mode !== "manual" && enabled);
      assert.equal(control.props.disabled, mode === "manual" || !configured);
      if (!control.props.disabled) {
        control.props.onChange(!enabled);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(invocation, !enabled);
        assert.equal(saved.autoApproveToolCalls, !enabled);
      }
    }
  }
});

test("approval notices are visible outside Browser and open the exact waiting tab", async () => {
  const ts = require("typescript");
  const vm = require("node:vm");
  const shell = appSource.slice(appSource.indexOf("function LauncherShell("), appSource.indexOf("function TitleBar("));
  const calls = [];
  let hookIndex = 0;
  let currentSurface = "settings";
  const sandbox = {
    element: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: value => [hookIndex++ === 0 ? currentSurface : value, () => {}],
    useRef: value => ({ current: value }), useEffect() {}, useLayoutEffect() {}, useCallback: callback => callback,
    window: { matchMedia: () => ({ matches: false }) }, COMPACT_SIDEBAR_QUERY: "fixture",
    useLimits: () => ({}), limitsCopyFor: () => ({}), browserTabTitleFromTitle: title => title,
    motion: { main: "main", aside: "aside", div: "div" },
    messageOf: String,
    hasClientIntegration: state => state.codexSetupComplete === true || state.claudeSetupComplete === true,
    hasVerifiedClientIntegration: state => state.codexCatalogVerified === true || state.claudeSetupComplete === true,
    api: {
      selectBrowserTab: async id => { calls.push(["select", id]); },
      setBrowserSurfaceActive: async active => { calls.push(["surface", active]); },
      showBrowser: async () => { calls.push(["show"]); },
    },
  };
  for (const name of new Set([...shell.matchAll(/<([A-Z][A-Za-z]+)/g)].map(match => match[1]))) sandbox[name] = name;
  vm.runInNewContext(ts.transpileModule(shell, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: "element",
  }, fileName: "shell.tsx" }).outputText + "\nrender = LauncherShell;", sandbox);
  const tab = { id: "waiting", title: "ChatGPT 2", status: "running", approvalPending: true };
  const other = { id: "selected", title: "ChatGPT 1", status: "running", active: true };
  const props = {
    browser: { authenticated: true, visible: false, tabs: [other, tab] },
    copy: { toolApprovalNeeded: "ChatGPT needs your approval", toolApprovalPendingBody: "Choose Allow once or Deny", openChatgpt: "Open ChatGPT" },
    language: "en", logs: [], operation: null, updateState() {}, setError(error) { throw new Error(error); },
    snapshot: { state: { browserInteractionMode: "automatic", coreSetupComplete: true,
      codexCatalogVerified: true, experimentalBiggerContext: true }, update: { status: "idle" }, profile: "production" },
  };
  const visit = tree => Array.isArray(tree) ? tree.flatMap(visit) : tree && typeof tree === "object"
    ? [tree, ...visit(tree.children ?? [])] : [];
  const render = () => { hookIndex = 0; return visit(sandbox.render(props)); };
  for (currentSurface of ["settings", "browser"]) {
    const notice = render().find(node => node.props.className === "tool-approval-notice");
    assert.ok(notice);
    assert.equal(notice.props.role, "status");
    const button = visit(notice).find(node => node.type === "SecondaryButton");
    button.props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.splice(0), [["select", "waiting"], ["surface", true], ["show"]]);
  }
  tab.approvalPending = false;
  assert.equal(render().some(node => node.props.className === "tool-approval-notice"), false);
  tab.approvalPending = true;
  tab.status = "ready";
  assert.equal(render().some(node => node.props.className === "tool-approval-notice"), false);
});

test("plugin rename invalidates verification only after success and rejects active browser work", async () => {
  const vm = require("node:vm");
  const handlers = new Map();
  const state = { mcpSetupComplete: true, mcpGuideStep: 0 };
  const events = [];
  let fail = true, calls = 0;
  const browserHost = { activeTraceId: "busy", currentOperation: () => null };
  vm.runInNewContext(electronMain.slice(
    electronMain.indexOf('handle("launcher:connector-name",'),
    electronMain.indexOf('handle("launcher:browser-interaction-mode",'),
  ), {
    handle: (name, handler) => handlers.set(name, handler), browserHost,
    runtimeHost: {
      setConnectorNameSuffix: async () => { calls++; if (fail) throw new Error("setup failed"); return { changed: true }; },
      browserConnectorName: () => "Codex Work",
      setupConnectorName: mode => mode === "manual" ? "Codex Zero Risk" : "Codex Work",
    },
    stateStore: { read: () => state, update: patch => Object.assign(state, patch) },
    send: (channel, body) => events.push({ channel, body }),
  });
  const rename = handlers.get("launcher:connector-name");
  await assert.rejects(rename(null, "Work"), /Finish active ChatGPT turns/);
  assert.equal(calls, 0);
  browserHost.activeTraceId = null;
  await assert.rejects(rename(null, "Work"), /setup failed/);
  assert.equal(state.mcpSetupComplete, true);
  assert.equal(events.length, 0);
  fail = false;
  await rename(null, "Work");
  assert.equal(state.mcpSetupComplete, false);
  assert.equal(state.mcpGuideStep, 2);
  assert.equal(events[0].channel, "launcher:connector-names-changed");
  assert.equal(events[0].body.connectorNames.manual, "Codex Zero Risk");
  assert.equal(events[1].channel, "launcher:state-changed");
});

test("plugin name editor keeps the Codex prefix and submits only the editable suffix", () => {
  const settings = fs.readFileSync(path.join(launcherRoot, "src/settings-surface.tsx"), "utf8");
  assert.match(settings, /currentPluginName\.slice\(6\)/);
  assert.match(settings, /<span aria-hidden="true">Codex<\/span>/);
  assert.match(settings, /maxLength=\{74\}/);
  assert.match(settings, /setConnectorNameSuffix\(nameSuffix\.trim\(\)\)/);
  assert.match(settings, /setConfirmNameChange\(true\)/);
});


test("catalog recovery clears its error banner but preserves a newer unrelated failure", () => {
  const vm = require("node:vm");
  const source = appSource.slice(appSource.indexOf("const unsubscribeOperation = api.onOperation"), appSource.indexOf("const unsubscribeLog ="));
  let callback, error = null;
  vm.runInNewContext(source, {
    api: { onOperation: fn => { callback = fn; } },
    setOperation() {}, catalogError: { current: null },
    setError: value => { error = typeof value === "function" ? value(error) : value; },
  });
  callback({ name: "catalog-verification", status: "failed", message: "Catalog error" });
  assert.equal(error, "Catalog error");
  callback({ name: "catalog-verification", status: "completed", message: "Loaded" });
  assert.equal(error, null);
  callback({ name: "catalog-verification", status: "failed", message: "Catalog error" });
  callback({ name: "setup", status: "failed", message: "Setup error" });
  callback({ name: "catalog-verification", status: "completed", message: "Loaded" });
  assert.equal(error, "Setup error");
});
