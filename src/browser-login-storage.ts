import type { BrowserContext } from "playwright-core";
import { CHATGPT_TEMPORARY_CHAT_URL } from "./chatgpt-session";

export type BrowserLoginStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
const LOGIN_STORAGE_ROOT_DOMAINS = ["chatgpt.com", "openai.com"] as const;
const CHATGPT_ORIGIN = new URL(CHATGPT_TEMPORARY_CHAT_URL).origin;

function allowedLoginStorageHost(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(hostname)
    || hostname.startsWith(".")
    || hostname.endsWith(".")
    || hostname.includes("..")) return false;
  try {
    const parsed = new URL(`https://${hostname}/`);
    if (parsed.hostname !== hostname
      || parsed.host !== hostname
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash) return false;
  } catch {
    return false;
  }
  return LOGIN_STORAGE_ROOT_DOMAINS.some(root => hostname === root || hostname.endsWith(`.${root}`));
}

export function sanitizeBrowserLoginStorageState(
  storageState: BrowserLoginStorageState,
): BrowserLoginStorageState {
  return {
    cookies: storageState.cookies
      .filter(cookie => !Object.prototype.hasOwnProperty.call(cookie, "partitionKey")
        && allowedLoginStorageHost(cookie.domain.replace(/^\.+/, "")))
      .map(cookie => ({ ...cookie })),
    origins: storageState.origins
      .filter(origin => origin.origin === CHATGPT_ORIGIN)
      .map(origin => ({
        origin: origin.origin,
        localStorage: origin.localStorage.map(item => ({ ...item })),
      })),
  };
}
