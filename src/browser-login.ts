import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type ConnectOverCDPTransport,
  type Page,
} from "playwright-core";
import type { AppConfig } from "./config";
import { atomicWriteFile, stripUtf8Bom } from "./config";
import {
  assertAuthenticatedChatGptPage,
  assertTemporaryChatPage,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_TEMPORARY_CHAT_URL,
  detectChatGptAccountCapabilities,
} from "./chatgpt-session";
import type { ChatGptWebAccountCapabilities } from "./chatgpt-web-models";

export interface BrowserLoginResult {
  storageStatePath: string;
  accountSurfaceUrl: string;
  solAvailable: boolean;
  proAvailable: boolean;
}

interface LoginVerificationMarker {
  version: 1;
  authenticated: true;
  verifiedAt: string;
  solAvailable?: boolean;
  proAvailable?: boolean;
}

interface LoginBrowserExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

const LOGIN_BROWSER_START_TIMEOUT_MS = 30_000;
const LOGIN_COMPLETION_TIMEOUT_MS = 10 * 60_000;
const LOGIN_POLL_INTERVAL_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

function loginBrowserExitError(exit: LoginBrowserExit, phase: string): Error {
  if (exit.error) return new Error(`System Chrome/Chromium ${phase}: ${exit.error.message}`);
  if (exit.signal) return new Error(`System Chrome/Chromium ${phase} after signal ${exit.signal}`);
  return new Error(`System Chrome/Chromium ${phase} with status ${exit.code ?? "unknown"}`);
}

function readDevToolsEndpoint(profileDir: string): string | undefined {
  try {
    const [rawPort, rawPath] = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").split(/\r?\n/, 2);
    if (!rawPort || !/^\d+$/.test(rawPort.trim())) return undefined;
    const port = Number(rawPort.trim());
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return undefined;
    const browserPath = rawPath?.trim();
    if (!browserPath || !/^\/devtools\/browser\/[A-Za-z0-9_-]{16,}$/.test(browserPath)) return undefined;
    return `ws://127.0.0.1:${port}${browserPath}`;
  } catch {
    return undefined;
  }
}

async function openNativeCdpTransport(endpoint: string, timeoutMs: number): Promise<ConnectOverCDPTransport> {
  const socket = new WebSocket(endpoint);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => {
      socket.close();
      rejectOpen(new Error("System Chrome/Chromium DevTools connection timed out"));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolveOpen();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      rejectOpen(new Error("System Chrome/Chromium rejected its loopback DevTools connection"));
    }, { once: true });
  });

  const transport: ConnectOverCDPTransport = {
    send(message) {
      socket.send(JSON.stringify(message));
    },
    close() {
      socket.close();
    },
  };
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      transport.onclose?.("System Chrome/Chromium returned a non-text DevTools message");
      socket.close();
      return;
    }
    try {
      transport.onmessage?.(JSON.parse(event.data) as object);
    } catch {
      transport.onclose?.("System Chrome/Chromium returned malformed DevTools JSON");
      socket.close();
    }
  });
  socket.addEventListener("close", event => transport.onclose?.(event.reason));
  return transport;
}

async function waitForDevToolsEndpoint(
  profileDir: string,
  browserExit: Promise<LoginBrowserExit>,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const endpoint = readDevToolsEndpoint(profileDir);
    if (endpoint) return endpoint;
    const exited = await Promise.race([
      browserExit,
      delay(Math.min(LOGIN_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now()))).then(() => undefined),
    ]);
    if (exited) throw loginBrowserExitError(exited, "closed before its private login session became inspectable");
  }
  throw new Error(`System Chrome/Chromium did not expose its private login session within ${timeoutMs}ms`);
}

async function waitForAuthenticatedTemporaryChat(
  context: BrowserContext,
  browserExit: Promise<LoginBrowserExit>,
  timeoutMs: number,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      try {
        await assertAuthenticatedChatGptPage(page);
        await assertTemporaryChatPage(page);
        return page;
      } catch {
        // Authentication redirects and provider pages are expected until the owned Temporary Chat is ready.
      }
    }
    const exited = await Promise.race([
      browserExit,
      delay(Math.min(LOGIN_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now()))).then(() => undefined),
    ]);
    if (exited) throw loginBrowserExitError(exited, "closed before ChatGPT authentication was verified");
  }
  throw new Error("Timed out waiting for an authenticated ChatGPT Temporary Chat in system Chrome/Chromium");
}

async function requireCleanLoginBrowserExit(
  browserExit: Promise<LoginBrowserExit>,
  timeoutMs = 30_000,
): Promise<void> {
  const exit = await Promise.race([
    browserExit,
    delay(timeoutMs).then(() => undefined),
  ]);
  if (!exit) throw new Error("System Chrome/Chromium did not exit after its verified login session was captured");
  if (exit.error || exit.signal || exit.code !== 0) throw loginBrowserExitError(exit, "did not close cleanly");
}

async function terminateOwnedLoginBrowser(
  child: ChildProcess,
  browserExit: Promise<LoginBrowserExit>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!Number.isInteger(pid) || !pid || pid < 1) {
    if (!child.kill("SIGTERM") && child.exitCode === null && child.signalCode === null) {
      throw new Error("Owned system Chrome/Chromium process has no valid pid and refused termination");
    }
  } else if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    const taskkill = win32.join(systemRoot, "System32", "taskkill.exe");
    const killed = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10_000,
    });
    if (killed.error) {
      throw new Error(`Could not terminate owned system Chrome/Chromium process tree ${pid}: ${killed.error.message}`);
    }
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  let exit = await Promise.race([browserExit, delay(3_000).then(() => undefined)]);
  if (!exit && process.platform !== "win32" && Number.isInteger(pid) && pid && pid > 0) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    exit = await Promise.race([browserExit, delay(2_000).then(() => undefined)]);
  }
  if (!exit) throw new Error("Owned system Chrome/Chromium process tree did not exit after termination");
}

async function closeOwnedLoginBrowser(
  browser: Browser,
  browserExit: Promise<LoginBrowserExit>,
): Promise<void> {
  if (browser.isConnected()) {
    const session = await browser.newBrowserCDPSession();
    // A browser attached through CDP treats Browser.close() on Playwright's Browser object as a
    // disconnect. Send the native command so the dedicated profile process really exits before
    // its sensitive temporary files can be removed or independently verified.
    void session.send("Browser.close").catch(() => {});
  }
  await requireCleanLoginBrowserExit(browserExit);
}

export function loginVerificationMarkerPath(storageStatePath: string): string {
  return `${storageStatePath}.verified.json`;
}

function writeVerificationMarker(
  storageStatePath: string,
  capabilities: ChatGptWebAccountCapabilities,
): void {
  const marker: LoginVerificationMarker = {
    version: 1,
    authenticated: true,
    verifiedAt: new Date().toISOString(),
    ...capabilities,
  };
  atomicWriteFile(loginVerificationMarkerPath(storageStatePath), `${JSON.stringify(marker)}\n`);
}

async function inspectStoredState(
  config: AppConfig,
  storageState: NonNullable<BrowserContextOptions["storageState"]>,
): Promise<ChatGptWebAccountCapabilities & { url: string }> {
  const verifierBrowser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless: false,
    ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const verifierContext = await verifierBrowser.newContext({ storageState });
    try {
      const verifierPage = await verifierContext.newPage();
      await verifierPage.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await verifierPage
        .locator(CHATGPT_COMPOSER_SELECTOR)
        .filter({ visible: true })
        .first()
        .waitFor({ state: "visible", timeout: 60_000 });
      await assertAuthenticatedChatGptPage(verifierPage);
      await assertTemporaryChatPage(verifierPage);
      return { ...await detectChatGptAccountCapabilities(verifierPage), url: verifierPage.url() };
    } finally {
      await verifierContext.close();
    }
  } finally {
    await verifierBrowser.close();
  }
}

export async function inspectBrowserLoginCapabilities(config: AppConfig): Promise<ChatGptWebAccountCapabilities> {
  if (!browserLoginStateExists(config)) throw new Error("ChatGPT login state is missing or unverified");
  const inspected = await inspectStoredState(config, config.storageStatePath);
  writeVerificationMarker(config.storageStatePath, inspected);
  return { solAvailable: inspected.solAvailable, proAvailable: inspected.proAvailable };
}

export function storedBrowserLoginCapabilities(
  config: AppConfig,
): Partial<ChatGptWebAccountCapabilities> {
  if (!browserLoginStateExists(config)) return {};
  try {
    const marker = JSON.parse(stripUtf8Bom(readFileSync(loginVerificationMarkerPath(config.storageStatePath), "utf8"))) as Partial<LoginVerificationMarker>;
    return {
      ...(typeof marker.solAvailable === "boolean" ? { solAvailable: marker.solAvailable } : {}),
      ...(typeof marker.proAvailable === "boolean" ? { proAvailable: marker.proAvailable } : {}),
    };
  } catch {
    return {};
  }
}

export async function loginToChatGpt(
  config: AppConfig,
  options: { timeoutMs?: number } = {},
): Promise<BrowserLoginResult> {
  if (!existsSync(config.chromeExecutablePath)) {
    throw new Error(`Chrome/Chromium was not found at ${config.chromeExecutablePath}. Pass --chrome with its executable path.`);
  }
  const profileDir = join(dirname(config.storageStatePath), "login-profile");
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  rmSync(join(profileDir, "DevToolsActivePort"), { force: true });
  process.stdout.write(
    "A dedicated system Chrome/Chromium window is open. Sign in to ChatGPT and leave it open; transfer continues automatically when the Temporary Chat composer is visible.\n",
  );
  const loginBrowser = spawn(config.chromeExecutablePath, [
    `--user-data-dir=${profileDir}`,
    "--new-window",
    "--disable-background-mode",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    CHATGPT_TEMPORARY_CHAT_URL,
  ], {
    detached: process.platform !== "win32",
    env: process.env,
    stdio: "ignore",
  });
  const browserExit = new Promise<LoginBrowserExit>((resolveExit) => {
    loginBrowser.once("error", error => resolveExit({ code: null, signal: null, error }));
    loginBrowser.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  let browser: Browser | undefined;
  let transport: ConnectOverCDPTransport | undefined;
  let browserProcessClosed = false;
  let result: BrowserLoginResult | undefined;
  let primaryError: unknown;
  try {
    const completionTimeoutMs = options.timeoutMs ?? LOGIN_COMPLETION_TIMEOUT_MS;
    const endpoint = await waitForDevToolsEndpoint(
      profileDir,
      browserExit,
      Math.min(LOGIN_BROWSER_START_TIMEOUT_MS, completionTimeoutMs),
    );
    transport = await openNativeCdpTransport(
      endpoint,
      Math.min(LOGIN_BROWSER_START_TIMEOUT_MS, completionTimeoutMs),
    );
    browser = await chromium.connectOverCDP(transport, {
      timeout: Math.min(LOGIN_BROWSER_START_TIMEOUT_MS, completionTimeoutMs),
    });
    const contexts = browser.contexts();
    if (contexts.length !== 1) {
      throw new Error(`System Chrome/Chromium exposed ${contexts.length} browser contexts; expected exactly one private login context`);
    }
    const context = contexts[0];
    const page = await waitForAuthenticatedTemporaryChat(context, browserExit, completionTimeoutMs);
    const state = await context.storageState();
    const accountSurfaceUrl = page.url();

    await closeOwnedLoginBrowser(browser, browserExit);
    browserProcessClosed = true;
    browser = undefined;

    const inspected = await inspectStoredState(config, state);
    atomicWriteFile(config.storageStatePath, `${JSON.stringify(state)}\n`);
    writeVerificationMarker(config.storageStatePath, inspected);
    result = {
      storageStatePath: config.storageStatePath,
      accountSurfaceUrl,
      solAvailable: inspected.solAvailable,
      proAvailable: inspected.proAvailable,
    };
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown;
  try {
    if (!browserProcessClosed) {
      if (browser) {
        try {
          await closeOwnedLoginBrowser(browser, browserExit);
        } catch {
          await terminateOwnedLoginBrowser(loginBrowser, browserExit);
        }
      } else {
        transport?.close();
        await terminateOwnedLoginBrowser(loginBrowser, browserExit);
      }
      browserProcessClosed = true;
    }
    rmSync(profileDir, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error;
  }

  if (primaryError) {
    if (cleanupError) {
      const primary = primaryError instanceof Error ? primaryError.message : String(primaryError);
      const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new Error(`${primary}; system-browser login cleanup also failed: ${cleanup}`);
    }
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
  if (!result) throw new Error("System-browser login completed without a verified result");
  return result;
}

export function browserLoginStateExists(config: AppConfig): boolean {
  if (!existsSync(config.storageStatePath)) return false;
  const markerPath = loginVerificationMarkerPath(config.storageStatePath);
  if (!existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(stripUtf8Bom(readFileSync(markerPath, "utf8"))) as Partial<LoginVerificationMarker>;
    return marker.version === 1 && marker.authenticated === true && typeof marker.verifiedAt === "string";
  } catch {
    return false;
  }
}

export async function checkBrowserEngine(config: AppConfig): Promise<void> {
  if (!existsSync(config.chromeExecutablePath)) throw new Error(`Chrome/Chromium was not found at ${config.chromeExecutablePath}`);
  const browser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    if (await page.evaluate(() => document.readyState) !== "complete") throw new Error("Browser page did not reach complete state");
  } finally {
    await browser.close();
  }
}
