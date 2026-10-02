import { randomUUID } from "node:crypto";
import type { Browser, Page } from "playwright-core";
import { connectLauncherBrowserHost, notifyLauncherTurn, LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS, type LauncherBrowserConnection } from "../../launcher-browser-host";
import { readChatGptUsageAccount, type ChatGptUsageModel } from "./limits";
import type { ChatGptWebModelMode } from "./model";
import type { StartupPageResource } from "./startup-page-pool";

export type StartupPageSelection = ChatGptWebModelMode & {
  modelFamily?: "5.6" | "6";
  selection?: { url: string; label: string };
  usageModel?: ChatGptUsageModel;
};
export type PreparedChatGptStartupPage = StartupPageResource & {
  selection: StartupPageSelection;
  account: Awaited<ReturnType<typeof readChatGptUsageAccount>>;
  takeConnection?(): LauncherBrowserConnection | undefined;
};

/** Real launcher ownership, account verification and browser transport; never sends a message. */
export async function prepareChatGptStartupPage(options: {
  descriptorPath: string;
  connectorIdentity: string;
  prefix: string;
  prepare(page: Page, signal: AbortSignal): Promise<StartupPageSelection>;
}, signal: AbortSignal): Promise<PreparedChatGptStartupPage> {
  const traceId = `startup_${randomUUID().replaceAll("-", "")}`;
  const owner = { traceId, helperPid: process.pid };
  let leased = false;
  let browser: Browser | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let released: Promise<void> | undefined;
  let available = true;
  const pauseHeartbeat = () => { if (timer) clearInterval(timer); timer = undefined; };
  const release = (): Promise<void> => {
    available = false;
    pauseHeartbeat();
    if (!leased) return Promise.resolve(); // An aborted acquisition is cleaned up by the launcher.
    return released ??= (async () => {
      signal.removeEventListener("abort", onAbort);
      try { await notifyLauncherTurn(options.descriptorPath, { ...owner, phase: "end", status: "aborted" }); }
      finally { await browser?.close(); }
    })();
  };
  const onAbort = () => { void release().catch(() => {}); }; // The preparation/owner awaits the same cleanup.
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    const lease = await notifyLauncherTurn(options.descriptorPath, {
      ...owner, phase: "start", connectorIdentity: options.connectorIdentity, startupPreparation: true,
    }, undefined, signal);
    leased = true;
    signal.throwIfAborted();
    if (!lease.surfaceId || lease.reused || lease.startupPrepared) throw new Error("Invalid startup page lease");
    timer = setInterval(() => {
      void notifyLauncherTurn(options.descriptorPath, { ...owner, phase: "heartbeat" })
        .catch(() => { void release().catch(() => {}); });
    }, LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS);
    timer.unref?.();
    const connection = await connectLauncherBrowserHost(options.descriptorPath, 30_000, lease.surfaceId, signal);
    browser = connection.browser;
    signal.throwIfAborted();
    const selection = await options.prepare(connection.page, signal);
    signal.throwIfAborted();
    const account = await readChatGptUsageAccount(connection.page);
    if (account.needsAttention) throw new Error("Startup account requires attention");
    signal.throwIfAborted();
    await notifyLauncherTurn(options.descriptorPath, { ...owner, phase: "prepared" }, undefined, signal);
    signal.throwIfAborted();
    return { surfaceId: lease.surfaceId, prefix: options.prefix, selection, account, pauseHeartbeat, release,
      isAvailable: () => available && browser?.isConnected() === true,
      takeConnection: () => {
        if (!available || browser?.isConnected() !== true) return undefined;
        available = false;
        pauseHeartbeat();
        browser = undefined; // The accepted work lease now owns this transport's cleanup.
        return connection;
      } };
  } catch (error) {
    signal.removeEventListener("abort", onAbort);
    try { await release(); }
    finally { await browser?.close(); }
    throw error;
  }
}
