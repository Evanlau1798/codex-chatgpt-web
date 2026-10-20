import type { Page } from "playwright-core";

const ownedPages = new WeakSet<Page>();
export function registerOwnedChatGptWorkPage(page: Page): void { ownedPages.add(page); }
/** Experimental UI compatibility, restricted to leased work pages; never changes profile or account preferences. */
export async function recoverOwnedTemporaryPersonalization(page: Page): Promise<boolean> {
  if (!ownedPages.has(page)) return false;
  return await page.evaluate(() => {
    const temporary = () => {
      try {
        const url = new URL(location.href);
        return url.origin === "https://chatgpt.com" && url.searchParams.get("temporary-chat") === "true"
          && (url.pathname === "/" || /^\/c\/[^/]+\/?$/.test(url.pathname));
      } catch { return false; }
    };
    if (!temporary()) return false;
    const w = window as any;
    const sdk = w.__STATSIG__, client = sdk?.firstInstance;
    if (!client || client.loadingStatus !== "Ready" || Object.keys(sdk.instances ?? {}).length !== 1) return false;
    const key = "__codexOwnedTemporaryPersonalization";
    const existing = w[key];
    if (existing) return existing.client === client && client.getFeatureGate === existing.getter;
    const descriptor = Object.getOwnPropertyDescriptor(client, "getFeatureGate");
    if (!descriptor?.writable || !descriptor.configurable || typeof descriptor.value !== "function"
      || typeof client.getLayer !== "function" || typeof client.$emt !== "function") return false;
    const original = descriptor.value;
    if (original.call(client, "2958953032", { disableExposureLog: true })?.value !== false
      || client.getLayer("2590740961", { disableExposureLog: true }).get("enabled", false) !== true) return false;
    const getter = function(this: unknown, name: string, options: unknown) {
      const value = original.call(this, name, options);
      if (name !== "2958953032" || value?.value !== false || !temporary() || client.loadingStatus !== "Ready") return value;
      try {
        if (client.getLayer("2590740961", { disableExposureLog: true }).get("enabled", false) !== true) return value;
      } catch { return value; }
      return { ...value, value: true };
    };
    const state = { client, getter };
    const restore = () => {
      window.removeEventListener("pagehide", restore);
      if (client.getFeatureGate === getter) Object.defineProperty(client, "getFeatureGate", descriptor);
      if (w[key] === state) delete w[key];
    };
    try {
      client.getFeatureGate = getter;
      w[key] = state;
      window.addEventListener("pagehide", restore, { once: true });
      client.$emt({ name: "values_updated", status: client.loadingStatus });
      return true;
    } catch {
      restore();
      return false;
    }
  }) === true;
}
