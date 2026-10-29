import { CHATGPT_COMPOSER_SELECTOR, chatGptThinkButtons } from "./chatgpt-ui/composer";
import {
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_MENU_SELECTOR,
  chatGptEffortSlider,
  readChatGptEffortSnapshot,
  openChatGptModelRows,
  type ChatGptEffortActivation,
} from "./chatgpt-ui/model-picker";
export * from "./chatgpt-ui/composer";
export * from "./chatgpt-ui/model-picker";
export * from "./chatgpt-ui/turns";
import { CHATGPT_EFFORT_SLIDER_MAX_OPTIONS, activateChatGptEffortMenu } from "./chatgpt-ui/model-picker";
import type { Locator, Page } from "playwright-core";
import { familyOption, selectChatGptModelFamily } from "./adapters/chatgpt-web/model-selection";
import type { ChatGptWebModelCapabilities, ChatGptWebAdapterEffort, ChatGptWebAccountCapabilities } from "./chatgpt-web-models";

export const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
export const CHATGPT_SAVED_CHAT_URL = "https://chatgpt.com/";
export const CHATGPT_NEW_CHAT_URL = CHATGPT_SAVED_CHAT_URL;

export function chatGptNewChatUrl(useSavedChats = false): string {
  return useSavedChats ? CHATGPT_SAVED_CHAT_URL : CHATGPT_TEMPORARY_CHAT_URL;
}
export const CHATGPT_TEMPORARY_CHAT_MODE_BUTTON_SELECTOR = [
  '[data-testid="thread-header-right-actions"] button[aria-haspopup="menu"]',
  '#conversation-header-actions button[aria-haspopup="menu"]',
  'div:has(> [data-testid="temporary-chat-label"]) + div button[aria-expanded]',
].join(", ");
export const CHATGPT_TEMPORARY_CHAT_ACTIVE_SELECTOR = [
  '[data-testid="temporary-chat-label"]',
  ...["header", "#conversation-header-actions", "[data-app-shell-header-obstacle]"].flatMap(scope =>
    ["codex-icon-chat-bubble-checkmark-dashed-light-20", "chat-bubble-checkmark-dashed-light-20", "chat-temp-checked"]
      .map(icon => `${scope} button:has(use[href$="#${icon}"])`)),
].join(", ");

export function normalizeChatGptModelAnnouncement(text: string): string {
  return text.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
}

/** Model identity precedes the localized slider position; punctuation is not language-specific. */
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

/** Submitted Temporary Chats may acquire a conversation URL while retaining their mode flag. */
export function isTemporaryChatGptTurnUrl(value: string): boolean {
  if (isTemporaryChatGptUrl(value)) return true;
  try {
    const url = new URL(value);
    return url.origin === new URL(CHATGPT_TEMPORARY_CHAT_URL).origin
      && /^\/c\/[^/]+$/.test(url.pathname)
      && url.searchParams.get("temporary-chat") === "true";
  } catch {
    return false;
  }
}

export function isSelectedChatGptTurnUrl(value: string, useSavedChats = false): boolean {
  if (!useSavedChats) return isTemporaryChatGptTurnUrl(value);
  try {
    const url = new URL(value);
    return url.origin === "https://chatgpt.com"
      && (url.pathname === "/" || /^\/c\/[^/]+$/.test(url.pathname))
      && url.searchParams.get("temporary-chat") !== "true";
  } catch { return false; }
}

/** The new renderer groups both roles under the user's stable turn key. */
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

export async function assertNewChatPage(page: Page, useSavedChats = false): Promise<void> {
  const url = new URL(page.url());
  const expected = new URL(CHATGPT_NEW_CHAT_URL);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname
    || (url.searchParams.get("temporary-chat") === "true") === useSavedChats) {
    throw new Error(`ChatGPT left the requested new chat surface (${page.url()})`);
  }
  if (await anyVisible(page.locator(CHATGPT_TEMPORARY_CHAT_ACTIVE_SELECTOR)) === useSavedChats) {
    throw new Error("ChatGPT rendered chat mode does not match the requested new chat surface");
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

type ChatGptCapabilityProbeOptions = {
  selectorTimeoutMs?: number;
  stableAbsenceMs?: number;
  signal?: AbortSignal;
};

/** Undefined means the known Luna/Think control was verified, not merely a missing picker. */
export async function waitForChatGptEffortControl(
  page: Page,
  options: ChatGptCapabilityProbeOptions = {},
): Promise<Locator | undefined> {
  const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
  const composer = composers;
  const composerForm = composer.locator("xpath=ancestor::form[1]");
  const effortButton = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true });
  const deadline = Date.now() + (options.selectorTimeoutMs ?? 30_000);
  const stableAbsenceMs = options.stableAbsenceMs ?? 3_000;
  let absenceSince: number | undefined;
  let presenceObservations = 0;
  while (true) {
    options.signal?.throwIfAborted();
    const effortVisible = await effortButton.isVisible();
    options.signal?.throwIfAborted();
    if (effortVisible) {
      presenceObservations += 1;
      absenceSince = undefined;
      if (presenceObservations >= 2) return effortButton;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
      continue;
    }
    presenceObservations = 0;
    const composerReady = await composers.count().then(count => count === 1).catch(() => false);
    const formReady = await composerForm.count().then(count => count === 1).catch(() => false);
    const documentReady = await page.evaluate(() => document.readyState === "complete").catch(() => false);
    if (composerReady && formReady && documentReady) {
      absenceSince ??= Date.now();
    } else {
      absenceSince = undefined;
    }
    if (Date.now() >= deadline) {
      // ChatGPT can mount a usable composer before the account's model list arrives.
      // A short absence is not a capability result; use the complete inspection budget.
      if (absenceSince !== undefined && Date.now() - absenceSince >= stableAbsenceMs) {
        options.signal?.throwIfAborted();
        // #932: UI drift on paid accounts must not overwrite the catalog with Luna-only.
        const think = chatGptThinkButtons(composer);
        const pressed = await think.count() === 1
          ? await think.first().getAttribute("aria-pressed", { timeout: 5_000, signal: options.signal })
          : null;
        options.signal?.throwIfAborted();
        if (pressed !== "true" && pressed !== "false") {
          throw new Error("Could not identify ChatGPT's model controls. Reload ChatGPT in the launcher and retry setup.");
        }
        return undefined;
      }
      throw new Error("ChatGPT account capability probe did not reach a stable composer state");
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
  }
}

export async function readChatGptEffortCapabilities(
  { sliderContainer, slider }: Pick<ChatGptEffortActivation, "sliderContainer" | "slider">,
  options: Pick<ChatGptCapabilityProbeOptions, "selectorTimeoutMs" | "signal"> = {},
): Promise<ChatGptWebAccountCapabilities & { extraHighAvailable: boolean }> {
  options.signal?.throwIfAborted();
  const timeout = options.selectorTimeoutMs ?? 70_000;
  // Model radio rows can hydrate before the effort control. They carry no evidence
  // of the account's reasoning range, so an absent slider must fail, not cache false.
  await sliderContainer.waitFor({ state: "visible", timeout, signal: options.signal });
  await slider.waitFor({ state: "attached", timeout, signal: options.signal });
  const { available } = await readChatGptEffortSnapshot(sliderContainer);
  options.signal?.throwIfAborted();
  return { solAvailable: true, extraHighAvailable: available[3] === true, proAvailable: available[4] === true };
}

export async function detectChatGptAccountCapabilities(
  page: Page,
  options: ChatGptCapabilityProbeOptions = {},
): Promise<ChatGptWebAccountCapabilities & { extraHighAvailable: boolean }> {
  const effortButton = await waitForChatGptEffortControl(page, options);
  if (!effortButton) return { solAvailable: false, extraHighAvailable: false, proAvailable: false, modelCapabilities: { observedAt: Date.now(), families: {} } };
  const menu = page.locator(CHATGPT_EFFORT_MENU_SELECTOR).filter({ visible: true }).last();
  try {
    const { sliderContainer, slider } = chatGptEffortSlider(page);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const menuVisible = await menu.isVisible().catch(() => false);
      const menuExpanded = await effortButton.getAttribute("aria-expanded").catch(() => null);
      if (!menuVisible) {
        if (menuExpanded === "true") await page.keyboard.press("Escape").catch(() => {});
        await effortButton.press("Enter");
      }
      try {
        const timeout = options.selectorTimeoutMs ?? 70_000;
        await sliderContainer.waitFor({ state: "visible", timeout, signal: options.signal });
        await slider.waitFor({ state: "attached", timeout, signal: options.signal });
        break;
      } catch (error) {
        if (attempt === 1) throw error;
        await page.keyboard.press("Escape").catch(() => {});
      }
    }
    const initial = await readChatGptEffortSnapshot(sliderContainer);
    let current: ChatGptEffortActivation = { method: "already-open", menu, sliderContainer, slider };
    const families = ["5.6", "6"] as const;
    const present: (typeof families[number])[] = [];
    let original: typeof families[number] | undefined;
    for (const family of families) {
      const option = await familyOption(current, family);
      const count = await option.count();
      if (count > 1) throw new Error("ChatGPT model capability probe found ambiguous family radios");
      if (count === 1) {
        present.push(family);
        if (await option.getAttribute("aria-checked") === "true") original = family;
      }
    }
    // Older selector variants have no family radios. Keep their existing account-only contract.
    if (present.length === 0) {
      return { solAvailable: true, extraHighAvailable: initial.available[3] === true, proAvailable: initial.available[4] === true };
    }
    const astra = menu.getByRole("menuitemradio", { name: /^GPT[-\s]?6\s+Astra$/i, exact: true, includeHidden: true });
    const defaults = menu.getByRole("menuitemradio", { name: /^Default(?:\s+Recommended set of models)?$/i, exact: true, includeHidden: true });
    const hasAstra = await astra.count() === 1;
    const originalAstra = hasAstra && await astra.getAttribute("aria-checked") === "true";
    const originalDefault = await defaults.count() === 1 && await defaults.getAttribute("aria-checked") === "true";
    if (Number(!!original) + Number(originalAstra) + Number(originalDefault) !== 1) {
      throw new Error("ChatGPT model capability probe could not verify the selected family");
    }
    const modelCapabilities: ChatGptWebModelCapabilities = { observedAt: Date.now(), families: {} };
    const effortOrder: ChatGptWebAdapterEffort[] = ["low", "medium", "high", "xhigh", "max"];
    const reopen = () => activateChatGptEffortMenu(page, effortButton);
    try {
      for (const family of present) {
        options.signal?.throwIfAborted();
        // Family changes can replace the menu node; reacquire the composer-owned menu.
        current = await reopen();
        current = await selectChatGptModelFamily(current, family, reopen);
        const snapshot = await readChatGptEffortSnapshot(current.sliderContainer);
        modelCapabilities.families[family] = effortOrder.filter((_, index) => snapshot.available[index] === true);
        if (family === "6" && hasAstra) {
          current = await selectChatGptModelFamily(current, family, reopen, "max");
          const pro = await readChatGptEffortSnapshot(current.sliderContainer);
          modelCapabilities.families[family] = effortOrder.filter((effort, index) =>
            effort === "max" ? pro.available[index] === true : snapshot.available[index] === true);
        }
      }
    } finally {
      // Inspection must not change the user's next model or effort, even after a probe failure.
      current = await reopen();
      if (originalDefault) {
        await openChatGptModelRows(current.menu);
        await defaults.click({ timeout: 5_000 });
        current = await reopen();
        if (await defaults.getAttribute("aria-checked") !== "true") {
          throw new Error("ChatGPT capability probe could not restore the original Default model");
        }
      } else {
        current = await selectChatGptModelFamily(current, originalAstra ? "6" : original!, reopen, originalAstra ? "max" : undefined);
      }
      const target = initial.value - initial.min;
      for (let step = 0; step <= CHATGPT_EFFORT_SLIDER_MAX_OPTIONS; step++) {
        const state = await readChatGptEffortSnapshot(current.sliderContainer);
        const index = state.value - state.min;
        if (index === target) break;
        if (step === CHATGPT_EFFORT_SLIDER_MAX_OPTIONS || !state.available[target]) {
          throw new Error("ChatGPT capability probe could not restore the original effort");
        }
        const owner = current.slider.locator("xpath=ancestor::*[@role='menuitem'][1]");
        await (await owner.count() === 1 ? owner : current.slider).press(index < target ? "ArrowRight" : "ArrowLeft");
        const deadline = Date.now() + 5_000;
        let changed = state;
        do {
          changed = await readChatGptEffortSnapshot(current.sliderContainer);
          if (changed.value !== state.value) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        if (changed.min !== state.min
          || !chatGptEffortSliderAdvancedTowardTarget(state.value, changed.value, state.min + target)) {
          throw new Error("ChatGPT capability probe could not verify effort restoration");
        }
      }
    }
    const observed = Object.values(modelCapabilities.families).flat();
    return { solAvailable: true, extraHighAvailable: observed.includes("xhigh"),
      proAvailable: observed.includes("max"), modelCapabilities };
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
  }
}
