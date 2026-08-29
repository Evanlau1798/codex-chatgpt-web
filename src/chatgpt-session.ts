import type { Locator, Page } from "playwright-core";
import type { ChatGptWebAccountCapabilities } from "./chatgpt-web-models";

export const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
export const CHATGPT_COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  '[contenteditable="true"][data-lexical-editor="true"]',
].join(", ");
export const CHATGPT_EFFORT_CONTROL_SELECTOR = [
  'button[data-tone="neutral"][aria-haspopup="menu"]',
  'button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]',
].join(", ");
export const CHATGPT_EFFORT_MENU_SELECTOR = [
  '[data-testid="composer-intelligence-picker-content"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="menu"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="group"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
].join(", ");
export const CHATGPT_EFFORT_ITEM_SELECTOR = '[role="menuitemradio"]';
export const CHATGPT_EFFORT_SLIDER_SELECTOR = [
  '[data-testid="composer-intelligence-picker-content"] [role="slider"]',
  '[data-model-reasoning-effort-slider] [role="slider"]',
].join(", ");
export const CHATGPT_EFFORT_SLIDER_MAX_OPTIONS = 5;
export const CHATGPT_TEMPORARY_CHAT_MODE_BUTTON_SELECTOR = [
  '[data-testid="thread-header-right-actions"] button[aria-haspopup="menu"]',
  '#conversation-header-actions button[aria-haspopup="menu"]',
  'div:has(> [data-testid="temporary-chat-label"]) + div button[aria-expanded]',
].join(", ");
export const CHATGPT_STOP_BUTTON_SELECTOR = '[data-testid="stop-button"]';
export const CHATGPT_COMPLETION_ACTION_SELECTOR = 'button[data-testid="copy-turn-action-button"]';
export const CHATGPT_ASSISTANT_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="assistant"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
].join(", ");
export const CHATGPT_USER_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="user"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="user"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"])',
].join(", ");

export function isTemporaryChatGptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const expected = new URL(CHATGPT_TEMPORARY_CHAT_URL);
    return url.origin === expected.origin
      && url.pathname === expected.pathname
      && url.searchParams.get("temporary-chat") === "true";
  } catch {
    return false;
  }
}

export interface ChatGptEffortSliderState {
  min: number;
  max: number;
  value: number;
}

function safeIntegerAttribute(value: string | null): number | undefined {
  if (value === null || !/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseChatGptEffortSliderState(
  rawMin: string | null,
  rawMax: string | null,
  rawValue: string | null,
): ChatGptEffortSliderState | undefined {
  const min = safeIntegerAttribute(rawMin);
  const max = safeIntegerAttribute(rawMax);
  const value = safeIntegerAttribute(rawValue);
  if (min === undefined || max === undefined || value === undefined) return undefined;
  const optionCount = max - min + 1;
  if (optionCount < 1 || optionCount > CHATGPT_EFFORT_SLIDER_MAX_OPTIONS) return undefined;
  if (value < min || value > max) return undefined;
  return { min, max, value };
}

export function chatGptEffortSliderAdvancedTowardTarget(previous: number, current: number, target: number): boolean {
  return target > previous
    ? current > previous && current <= target
    : current < previous && current >= target;
}

async function anyVisible(locator: Locator): Promise<boolean> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

export async function assertAuthenticatedChatGptPage(page: Page): Promise<void> {
  const composer = page.locator(
    CHATGPT_COMPOSER_SELECTOR,
  );
  if (!await anyVisible(composer)) {
    throw new Error("ChatGPT authentication could not be verified: no visible composer is present");
  }
}

export async function assertTemporaryChatPage(page: Page): Promise<void> {
  if (!isTemporaryChatGptUrl(page.url())) {
    throw new Error(`ChatGPT left the isolated Temporary Chat surface (${page.url()})`);
  }
}

export async function ensureChatGptTemporaryChatPersonalized(
  page: Page,
  options: { controlTimeoutMs?: number } = {},
): Promise<void> {
  const buttons = page.locator(CHATGPT_TEMPORARY_CHAT_MODE_BUTTON_SELECTOR).filter({ visible: true });
  const deadline = Date.now() + (options.controlTimeoutMs ?? 5_000);
  let buttonCount = await buttons.count();
  while (buttonCount === 0 && Date.now() < deadline) {
    await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
    buttonCount = await buttons.count();
  }
  // Some authenticated Temporary Chat variants expose connectors directly and
  // do not render a personalization toggle. Connector discovery remains the
  // authoritative pre-submit check on those surfaces.
  if (buttonCount === 0) return;
  if (buttonCount !== 1) {
    throw new Error(`ChatGPT Temporary Chat exposed ${buttonCount} personalization controls`);
  }
  const button = buttons.first();
  const menu = page.locator([
    '[role="menu"]:has([role="menuitemradio"])',
    '[role="radiogroup"]:has([role="radio"])',
  ].join(", ")).filter({ visible: true }).last();
  const modes = menu.locator('[role="menuitemradio"], [role="radio"]');
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await button.press("Enter");
      try {
        await modes.first().waitFor({ state: "visible", timeout: 5_000 });
        break;
      } catch (error) {
        if (attempt === 1) throw error;
        await page.keyboard.press("Escape").catch(() => {});
      }
    }
    if (await modes.count() !== 2) throw new Error("ChatGPT Temporary Chat personalization menu changed");
    const firstChecked = await modes.first().getAttribute("aria-checked");
    const secondChecked = await modes.nth(1).getAttribute("aria-checked");
    if (firstChecked === "true" && secondChecked === "false") return;
    if (firstChecked !== "false" || secondChecked !== "true") {
      throw new Error("ChatGPT Temporary Chat personalization menu lost its semantic radio state");
    }
    await modes.first().press("Enter");
    const deadline = Date.now() + 5_000;
    while (await button.getAttribute("aria-expanded") !== "false" && Date.now() < deadline) {
      await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
    }
    await button.press("Enter");
    await modes.first().waitFor({ state: "visible", timeout: 5_000 });
    if (await modes.first().getAttribute("aria-checked") !== "true"
      || await modes.nth(1).getAttribute("aria-checked") !== "false") {
      throw new Error("ChatGPT did not enable Temporary Chat personalization for connector access");
    }
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
  }
}

export async function detectChatGptAccountCapabilities(
  page: Page,
  options: { selectorTimeoutMs?: number; stableAbsenceMs?: number } = {},
): Promise<ChatGptWebAccountCapabilities> {
  const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
  const composer = composers.last();
  const composerForm = composer.locator("xpath=ancestor::form[1]");
  const effortButton = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).last();
  const deadline = Date.now() + (options.selectorTimeoutMs ?? 30_000);
  const stableAbsenceMs = options.stableAbsenceMs ?? 3_000;
  let absenceSince: number | undefined;
  let presenceObservations = 0;
  while (true) {
    const effortVisible = await effortButton.isVisible().catch(() => false);
    if (effortVisible) {
      presenceObservations += 1;
      absenceSince = undefined;
      if (presenceObservations >= 2) break;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
      continue;
    }
    presenceObservations = 0;
    const composerReady = await composers.count().then(count => count === 1).catch(() => false);
    const formReady = await composerForm.count().then(count => count === 1).catch(() => false);
    const documentReady = await page.evaluate(() => document.readyState === "complete").catch(() => false);
    if (composerReady && formReady && documentReady) {
      absenceSince ??= Date.now();
      if (Date.now() - absenceSince >= stableAbsenceMs) {
        return { solAvailable: false, proAvailable: false };
      }
    } else {
      absenceSince = undefined;
    }
    if (Date.now() >= deadline) {
      throw new Error("ChatGPT account capability probe did not reach a stable composer state");
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
  }
  const menu = page.locator(CHATGPT_EFFORT_MENU_SELECTOR).filter({ visible: true }).last();
  try {
    const efforts = menu.locator(CHATGPT_EFFORT_ITEM_SELECTOR);
    const slider = page.locator(CHATGPT_EFFORT_SLIDER_SELECTOR).last();
    let ready: "items" | "slider" | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const menuVisible = await menu.isVisible().catch(() => false);
      const menuExpanded = await effortButton.getAttribute("aria-expanded").catch(() => null);
      if (!menuVisible && menuExpanded !== "true") await effortButton.press("Enter");
      const waitAbort = new AbortController();
      try {
        ready = await Promise.race([
          efforts.first().waitFor({ state: "visible", timeout: 10_000, signal: waitAbort.signal })
            .then(() => "items" as const),
          slider.waitFor({ state: "attached", timeout: 10_000, signal: waitAbort.signal })
            .then(() => "slider" as const),
        ]);
        break;
      } catch (error) {
        if (attempt === 1) throw error;
        await page.keyboard.press("Escape").catch(() => {});
      } finally {
        waitAbort.abort();
      }
    }
    const sliderAttached = await slider.count().then(count => count === 1).catch(() => false);
    if (ready === "items" && !sliderAttached) {
      return { solAvailable: true, proAvailable: await efforts.count() >= 5 };
    }
    const state = parseChatGptEffortSliderState(
      await slider.getAttribute("aria-valuemin"),
      await slider.getAttribute("aria-valuemax"),
      await slider.getAttribute("aria-valuenow"),
    );
    if (!state) throw new Error("ChatGPT effort slider exposed an invalid ARIA range");
    return { solAvailable: true, proAvailable: state.max - state.min + 1 >= 5 };
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
  }
}
