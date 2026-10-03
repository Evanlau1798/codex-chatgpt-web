import type { Page } from "playwright-core";
import { CHATGPT_COMPOSER_SELECTOR, CHATGPT_STOP_BUTTON_SELECTOR } from "../../chatgpt-session";

export const NATIVE_SHORTCUTS = ["codex_read_context", "codex_exec", "codex_write_stdin", "codex_apply_patch", "codex_view_image", "codex_tool_inventory", "codex_tool_call"] as const;
export type NativePermissionMode = "all_tools" | "low_risk" | "ask" | "unknown";
export interface NativePluginReadiness {
  version: 1;
  source: "chatgpt_settings_dom";
  observedAt: number;
  permission: NativePermissionMode;
  advertised: string[];
  missing: string[];
  permissionPolicyMayDenyWrites: boolean;
}

export function nativePermissionMode(text: string): NativePermissionMode {
  // Only the observed permission-control value, never arbitrary page prose.
  if (/\bAllow all tools\s*$/.test(text)) return "all_tools";
  if (/\bAllow low-risk tools(?:\s*\(Default\))?\s*$/.test(text)) return "low_risk";
  if (/\b(?:Always ask|Ask every time)\s*$/.test(text)) return "ask";
  return "unknown";
}

export function assertNativePluginReadiness(value: unknown): asserts value is NativePluginReadiness {
  const v = value as NativePluginReadiness;
  if (!v || v.version !== 1 || v.source !== "chatgpt_settings_dom" || !Number.isFinite(v.observedAt)
    || Math.abs(Date.now() - v.observedAt) > 120_000
    || !["all_tools", "low_risk", "ask", "unknown"].includes(v.permission)
    || !Array.isArray(v.advertised) || !Array.isArray(v.missing)
    || [...v.advertised, ...v.missing].some(name => !NATIVE_SHORTCUTS.includes(name as typeof NATIVE_SHORTCUTS[number]))
    || new Set(v.advertised).size !== v.advertised.length
    || JSON.stringify([...v.missing].sort()) !== JSON.stringify(NATIVE_SHORTCUTS.filter(name => !v.advertised.includes(name)).sort())
    || v.permissionPolicyMayDenyWrites !== (v.permission !== "all_tools")) throw new Error("Native plugin readiness evidence is invalid");
}

/** Read-only UI navigation on an exclusively owned idle maintenance surface. No Send or permission change. */
export async function inspectNativePluginReadiness(page: Page, appName: string): Promise<NativePluginReadiness> {
  const previous = page.url();
  const escaped = appName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (await page.locator(CHATGPT_STOP_BUTTON_SELECTOR).filter({ visible: true }).count() > 0) {
    throw new Error("native_readiness_generation_active: navigation refused");
  }
  const composer = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
  if (await composer.count() > 0 && (await composer.first().textContent())?.trim()) {
    throw new Error("native_readiness_unsent_draft: navigation refused");
  }
  try {
    await page.goto("https://chatgpt.com/settings/plugins-settings", { waitUntil: "domcontentloaded", timeout: 30_000 });
    const app = page.getByRole("button", { name: new RegExp(`^${escaped}(?:\\s|$)`) });
    await app.first().waitFor({ state: "visible", timeout: 30_000 });
    if (await app.count() !== 1) throw new Error("native_readiness_app_ambiguous");
    await app.click();
    const control = page.getByRole("button", { name: /^Permission Choose when ChatGPT should ask for permission/ });
    await control.waitFor({ state: "visible", timeout: 30_000 });
    const permission = nativePermissionMode((await control.innerText()).replace(/\s+/g, " ").trim());
    const path = new URL(page.url()).pathname;
    const identity = /^\/settings\/plugins-settings\/(plugin_[A-Za-z0-9_]+)$/.exec(path)?.[1];
    if (!identity) throw new Error("native_readiness_app_identity_missing");
    await page.goto(`https://chatgpt.com/plugins/${identity}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const connected = page.getByRole("button", { name: new RegExp(`^${escaped}\\s.*Connected$`) });
    await connected.first().waitFor({ state: "visible", timeout: 30_000 });
    if (await connected.count() !== 1) throw new Error("native_readiness_connection_ambiguous");
    await connected.click();
    await page.getByText("Tools for this app", { exact: true }).first().waitFor({ state: "visible", timeout: 30_000 });
    // The heading renders before the asynchronously loaded tool catalog.
    await page.getByText(/codex_apply_patch/).first().waitFor({ state: "visible", timeout: 30_000 });
    const toolText = await page.getByText(/^codex_[a-z_]+(?:\s|$)/).allTextContents();
    const names = new Set(toolText.map(text => /^(codex_[a-z_]+)(?:\s|$)/.exec(text.trim())?.[1]).filter(Boolean));
    console.info(`[chatgpt-web] native_readiness ${JSON.stringify({ catalogRows: toolText.length,
      observedTools: NATIVE_SHORTCUTS.filter(name => names.has(name)), outcome: "observed" })}`);
    const advertised = NATIVE_SHORTCUTS.filter(name => names.has(name));
    return { version: 1, source: "chatgpt_settings_dom", observedAt: Date.now(), permission, advertised,
      missing: NATIVE_SHORTCUTS.filter(name => !names.has(name)), permissionPolicyMayDenyWrites: permission !== "all_tools" };
  } finally {
    if (!page.isClosed() && new URL(previous).origin === "https://chatgpt.com") {
      await page.goto(previous, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
  }
}
