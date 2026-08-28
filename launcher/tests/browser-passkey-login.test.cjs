const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  importVerifiedChatGptCookies,
  readVerifiedChatGptCookies,
} = require("../electron/browser-login-state.cjs");
const { openBrowserLogin, openExternalLogin } = require("../electron/browser-login-flow.cjs");

function writeVerifiedState(root, cookies) {
  const statePath = path.join(root, "storage-state.json");
  fs.writeFileSync(statePath, JSON.stringify({
    cookies,
    origins: [{ origin: "https://chatgpt.com", localStorage: [{ name: "ignored", value: "ignored" }] }],
  }));
  fs.writeFileSync(`${statePath}.verified.json`, JSON.stringify({
    version: 1,
    authenticated: true,
    verifiedAt: new Date().toISOString(),
  }));
  return statePath;
}

test("verified storage imports only ChatGPT and OpenAI cookies", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-login-state-"));
  try {
    const statePath = writeVerifiedState(root, [
      { name: "host", value: "one", domain: "chatgpt.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
      { name: "shared", value: "two", domain: ".openai.com", path: "/auth", expires: 2_000_000_000, httpOnly: false, secure: true, sameSite: "None" },
      { name: "idp", value: "secret", domain: ".accounts.google.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
      { name: "lookalike", value: "secret", domain: "evilchatgpt.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
    ]);

    assert.deepEqual(readVerifiedChatGptCookies(statePath), [
      {
        url: "https://chatgpt.com/",
        name: "host",
        value: "one",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "lax",
      },
      {
        url: "https://openai.com/auth",
        name: "shared",
        value: "two",
        domain: ".openai.com",
        path: "/auth",
        httpOnly: false,
        secure: true,
        sameSite: "no_restriction",
        expirationDate: 2_000_000_000,
      },
    ]);

    const events = [];
    const browserSession = {
      clearStorageData: async () => events.push("clear"),
      flushStorageData: () => events.push("flush-storage"),
      cookies: {
        set: async cookie => events.push(["set", cookie.name]),
        flushStore: async () => events.push("flush-cookies"),
      },
    };
    assert.equal(await importVerifiedChatGptCookies(browserSession, statePath), 2);
    assert.deepEqual(events, [
      "clear",
      "flush-storage",
      "flush-cookies",
      ["set", "host"],
      ["set", "shared"],
      "flush-storage",
      "flush-cookies",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cookie import clears the Electron partition again after a failed write", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-login-failure-"));
  try {
    const statePath = writeVerifiedState(root, [
      { name: "session", value: "secret", domain: "chatgpt.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
    ]);
    let clears = 0;
    const browserSession = {
      clearStorageData: async () => { clears += 1; },
      flushStorageData() {},
      cookies: {
        set: async () => { throw new Error("write failed"); },
        flushStore: async () => {},
      },
    };
    await assert.rejects(importVerifiedChatGptCookies(browserSession, statePath), /Could not import verified ChatGPT session cookies/);
    assert.equal(clears, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher login uses normal Chrome when configured and embedded login only when missing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-login-flow-"));
  try {
    const chromePath = path.join(root, "chrome.exe");
    const statePath = path.join(root, "storage-state.json");
    fs.writeFileSync(chromePath, "fake");
    const calls = [];
    let probes = 0;
    const browserSession = {
      clearStorageData: async () => {},
      flushStorageData() {},
      cookies: { set: async () => {}, flushStore: async () => {} },
    };
    const runtimeHost = {
      runtimeConfigSnapshot: () => ({ config: { chromeExecutablePath: chromePath, storageStatePath: statePath } }),
      launcherControlEnvironment: () => ({ CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: "test-token" }),
      run: async (...args) => {
        calls.push(["run", ...args]);
        writeVerifiedState(root, [
          { name: "session", value: "secret", domain: "chatgpt.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
        ]);
      },
    };
    const browserHost = {
      state: { authenticated: false },
      loginOperation: null,
      view: { webContents: {
        getURL: () => "https://chatgpt.com/?temporary-chat=true",
        loadURL: async () => {},
        isDestroyed: () => false,
        session: browserSession,
      } },
      activateHomeSurface() {},
      show() {},
      withManualOperation: async (_name, action) => action(),
      probeAuthentication: async () => ({ authenticated: ++probes > 1 }),
      runSessionInspection: async () => {},
      snapshot: () => ({ authenticated: true }),
      setState() {},
      logger: { info() {}, warn() {} },
      authView: null,
      openLogin: async () => { calls.push(["embedded"]); return { authenticated: false }; },
    };

    assert.deepEqual(await openBrowserLogin({ browserHost, runtimeHost, isDevProfile: false }), { authenticated: true });
    assert.deepEqual(calls[0].slice(0, 3), ["run", "browser-login", ["login", "--external-browser"]]);
    assert.deepEqual(calls[0][3].env, { CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: "test-token" });

    fs.rmSync(chromePath);
    calls.length = 0;
    await openBrowserLogin({ browserHost, runtimeHost, isDevProfile: false });
    assert.deepEqual(calls, [["embedded"]]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("external login imports then re-proves authentication in the Electron partition", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-login-host-"));
  try {
    const statePath = writeVerifiedState(root, [
      { name: "session", value: "secret", domain: "chatgpt.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
    ]);
    const events = [];
    let probes = 0;
    const browserSession = {
      clearStorageData: async () => events.push("clear"),
      flushStorageData: () => events.push("flush-storage"),
      cookies: {
        set: async cookie => events.push(["set", cookie.name]),
        flushStore: async () => events.push("flush-cookies"),
      },
    };
    const fixture = {
      state: { authenticated: false },
      loginOperation: null,
      view: { webContents: {
        isDestroyed: () => false,
        getURL: () => "https://chatgpt.com/?temporary-chat=true",
        loadURL: async url => events.push(["load", url]),
        session: browserSession,
      } },
      activateHomeSurface: () => events.push("home"),
      show: () => events.push("show"),
      withManualOperation: async (_name, action) => action(),
      probeAuthentication: async () => ({ authenticated: ++probes > 1 }),
      runSessionInspection: async () => events.push("inspect"),
      snapshot: () => ({ authenticated: true }),
      setState() {},
      logger: { info: (name, detail) => events.push([name, detail]), warn() {} },
      authView: null,
    };

    const result = await openExternalLogin(fixture, {
      storageStatePath: statePath,
      runLogin: async () => events.push("normal-chrome"),
    });
    assert.deepEqual(result, { authenticated: true });
    assert.ok(events.indexOf("normal-chrome") < events.findIndex(event => Array.isArray(event) && event[0] === "set"));
    assert.ok(events.includes("inspect"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
