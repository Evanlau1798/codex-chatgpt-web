import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium, type BrowserContextOptions, type Page } from "playwright-core";
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

export async function verifyBrowserLoginPage(
  page: Page,
  options: { electronImport?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  await assertTemporaryChatPage(page);
  if (options.electronImport) {
    const authenticated = await page.evaluate(async (temporaryChatUrl) => {
      const expected = new URL(temporaryChatUrl);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch("/api/auth/session", {
          credentials: "include",
          cache: "no-store",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        const responseUrl = new URL(response.url);
        const payload = response.ok
          && responseUrl.origin === expected.origin
          && responseUrl.pathname === "/api/auth/session"
          && response.headers.get("content-type")?.includes("application/json")
          ? await response.json()
          : null;
        const user = payload?.user && typeof payload.user === "object" && !Array.isArray(payload.user)
          ? payload.user
          : null;
        const validExpiry = payload?.expires === undefined || payload.expires === null
          ? true
          : typeof payload.expires === "string"
            && Number.isFinite(Date.parse(payload.expires))
            && Date.parse(payload.expires) > Date.now();
        return Boolean(user && Object.keys(user).length > 0
          && (payload?.error === undefined || payload.error === null || payload.error === "")
          && validExpiry);
      } catch {
        return false;
      } finally {
        clearTimeout(timeout);
      }
    }, CHATGPT_TEMPORARY_CHAT_URL).catch(() => false);
    if (!authenticated) throw new Error("ChatGPT session could not be verified for Electron import");
    return;
  }
  const composer = page.getByRole("textbox", { name: "Chat with ChatGPT" }).or(
    page.locator(CHATGPT_COMPOSER_SELECTOR),
  ).first();
  try {
    await composer.waitFor({ state: "visible", timeout: options.timeoutMs ?? 60_000 });
  } catch {
    throw new Error("The authenticated ChatGPT page did not produce a visible composer");
  }
  await assertAuthenticatedChatGptPage(page);
}

async function inspectStoredState(
  config: AppConfig,
  storageState: NonNullable<BrowserContextOptions["storageState"]>,
  electronImport = false,
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
      await verifyBrowserLoginPage(verifierPage, { electronImport });
      const capabilities = electronImport
        ? { solAvailable: config.solAvailable, proAvailable: config.proAvailable }
        : await detectChatGptAccountCapabilities(verifierPage);
      return { ...capabilities, url: verifierPage.url() };
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
  options: { timeoutMs?: number; electronImport?: boolean } = {},
): Promise<BrowserLoginResult> {
  if (!existsSync(config.chromeExecutablePath)) {
    throw new Error(`Google Chrome was not found at ${config.chromeExecutablePath}. Pass --chrome with its executable path.`);
  }
  const profileDir = join(dirname(config.storageStatePath), "login-profile");
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  try {
    process.stdout.write(
      "A normal Chrome window is open. Sign in to ChatGPT, confirm that the composer is visible, then quit this dedicated Chrome instance completely.\n",
    );
    const loginBrowser = spawn(config.chromeExecutablePath, [
      `--user-data-dir=${profileDir}`,
      "--new-window",
      "--disable-background-mode",
      "--no-first-run",
      "--no-default-browser-check",
      CHATGPT_TEMPORARY_CHAT_URL,
    ], { env: process.env, stdio: "ignore" });
    const loginExit = await new Promise<number>((resolveExit, rejectExit) => {
      loginBrowser.once("error", rejectExit);
      loginBrowser.once("exit", (code, signal) => {
        if (signal) rejectExit(new Error(`Normal Chrome login window exited from signal ${signal}`));
        else resolveExit(code ?? 1);
      });
    });
    if (loginExit !== 0) throw new Error(`Normal Chrome login window exited with status ${loginExit}`);

    const context = await chromium.launchPersistentContext(profileDir, {
      executablePath: config.chromeExecutablePath,
      headless: false,
      ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    try {
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await verifyBrowserLoginPage(page, options);
      const state = await context.storageState();

      const inspected = await inspectStoredState(config, state, options.electronImport);
      atomicWriteFile(config.storageStatePath, `${JSON.stringify(state)}\n`);
      writeVerificationMarker(config.storageStatePath, inspected);
      return {
        storageStatePath: config.storageStatePath,
        accountSurfaceUrl: page.url(),
        solAvailable: inspected.solAvailable,
        proAvailable: inspected.proAvailable,
      };
    } finally {
      await context.close();
    }
  } finally {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
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
  if (!existsSync(config.chromeExecutablePath)) throw new Error(`Google Chrome was not found at ${config.chromeExecutablePath}`);
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
