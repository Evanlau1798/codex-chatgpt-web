const fs = require("node:fs");
const path = require("node:path");
const { importVerifiedChatGptCookies } = require("./browser-login-state.cjs");

const EXTERNAL_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";

function isTemporaryChatUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.origin === "https://chatgpt.com"
      && parsed.pathname === "/"
      && parsed.searchParams.get("temporary-chat") === "true";
  } catch {
    return false;
  }
}

function openExternalLogin(browserHost, { storageStatePath, runLogin }) {
  if (browserHost.state.authenticated) {
    browserHost.activateHomeSurface();
    browserHost.show();
    return Promise.resolve(browserHost.snapshot());
  }
  if (browserHost.loginOperation) {
    browserHost.activateHomeSurface();
    browserHost.show();
    return browserHost.loginOperation;
  }
  const operation = browserHost.withManualOperation("ChatGPT login", async () => {
    browserHost.authNavigationError = null;
    browserHost.show();
    const contents = browserHost.view.webContents;
    if (!isTemporaryChatUrl(contents.getURL())) await contents.loadURL(TEMPORARY_CHAT_URL);
    const existing = await browserHost.probeAuthentication();
    if (existing.authenticated) return existing;

    browserHost.setState({ status: "loading", message: "Waiting for normal Chrome login", authenticated: false });
    browserHost.logger.info("browser.external_login_opened");
    try {
      await runLogin();
      if (browserHost.authView) browserHost.closeAuthView(browserHost.authView, true, false);
      const cookieCount = await importVerifiedChatGptCookies(contents.session, storageStatePath);
      await contents.loadURL(TEMPORARY_CHAT_URL);
      const authenticated = await browserHost.probeAuthentication();
      if (!authenticated.authenticated) {
        throw new Error("Imported normal Chrome session did not authenticate the Electron browser");
      }
      await browserHost.runSessionInspection(false);
      browserHost.logger.info("browser.external_login_imported", { cookieCount });
      return browserHost.snapshot();
    } catch (error) {
      await contents.session.clearStorageData().catch(() => {});
      contents.session.flushStorageData();
      await contents.session.cookies.flushStore().catch(() => {});
      if (!contents.isDestroyed()) {
        await contents.loadURL(TEMPORARY_CHAT_URL).catch(() => {});
        await browserHost.probeAuthentication().catch(() => {});
      }
      browserHost.logger.warn("browser.external_login_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });
  const tracked = operation.finally(() => {
    if (browserHost.loginOperation === tracked) browserHost.loginOperation = null;
  });
  browserHost.loginOperation = tracked;
  return tracked;
}

async function openBrowserLogin({ browserHost, runtimeHost, isDevProfile }) {
  const config = runtimeHost.runtimeConfigSnapshot().config;
  const chromeExecutablePath = config?.chromeExecutablePath;
  if (typeof chromeExecutablePath !== "string" || !chromeExecutablePath.trim()) {
    return browserHost.openLogin();
  }
  if (!path.isAbsolute(chromeExecutablePath)) {
    throw new Error("Configured Chrome executable path must be absolute");
  }
  if (!fs.statSync(chromeExecutablePath, { throwIfNoEntry: false })?.isFile()) {
    return browserHost.openLogin();
  }
  const storageStatePath = config?.storageStatePath;
  if (typeof storageStatePath !== "string" || !path.isAbsolute(storageStatePath)) {
    throw new Error("Configured ChatGPT storage state path must be absolute");
  }
  let environment;
  if (isDevProfile) {
    if (typeof runtimeHost.coreHome !== "string" || !path.isAbsolute(runtimeHost.coreHome)) {
      throw new Error("DEV external login requires an absolute isolated runtime home");
    }
    environment = runtimeHost.devSetupEnvironment();
    environment.CODEX_CHATGPT_WEB_HOME = runtimeHost.coreHome;
  }
  const options = {
    timeoutMs: EXTERNAL_LOGIN_TIMEOUT_MS,
    message: "Sign in to ChatGPT in the normal Chrome window, then close it",
    successMessage: "Normal Chrome login verified",
    env: runtimeHost.launcherControlEnvironment(),
    ...(environment ? { environment } : {}),
  };
  return openExternalLogin(browserHost, {
    storageStatePath,
    runLogin: () => runtimeHost.run("browser-login", ["login", "--external-browser"], options),
  });
}

module.exports = { openBrowserLogin, openExternalLogin };
