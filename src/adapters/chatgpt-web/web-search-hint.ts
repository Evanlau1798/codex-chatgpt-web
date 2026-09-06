import type { Locator, Page } from "playwright-core";

/**
 * Observed on chatgpt.com Temporary Chat (2026-09-06, Pro account, Sol composer):
 * - The composer "+" control is `button[data-testid="composer-plus-btn"][aria-haspopup="menu"]`.
 * - Enter opens a `div.popover` whose rows are `div.__menu-item[tabindex="0"]` elements with no
 *   ARIA menu roles. Temporary Chat lists "Add photos & files", "Web search", and "Visualize".
 * - Activating the "Web search" row inserts exactly one inline pill into the ProseMirror composer:
 *   `<span data-inline-selection-pill data-id="search" data-symbol="ecosystemMention"
 *   data-keyword="Web search" data-system-hint-type="search">Web search</span>` followed by a space.
 *   Select-all plus Backspace removes it again.
 */
export const CHATGPT_WEB_SEARCH_HINT_LABEL = "Web search";
export const CHATGPT_WEB_SEARCH_HINT_SELECTOR =
  '[data-inline-selection-pill][data-system-hint-type="search"][data-keyword="Web search"]';
export const CHATGPT_COMPOSER_MENU_ROW_SELECTOR = '.__menu-item[tabindex="0"]';

const WEB_SEARCH_MENU_TIMEOUT_MS = 5_000;

export function selectedChatGptWebSearchHint(composer: Locator): Locator {
  return composer.locator(CHATGPT_WEB_SEARCH_HINT_SELECTOR);
}

/**
 * Select ChatGPT's own Web search hint in an empty composer. The caller must clear the composer
 * first and attach the prompt after the pill; the hint is part of the message, not a mode toggle.
 * Every ambiguity fails closed so a turn never silently runs without the requested search.
 */
export async function selectChatGptWebSearchHint(
  page: Page,
  composer: Locator,
  captureDiagnostic?: (checkpoint: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const options = { signal, timeout: WEB_SEARCH_MENU_TIMEOUT_MS };
  const hint = selectedChatGptWebSearchHint(composer);
  const existing = await hint.count();
  if (existing > 1) throw new Error("ChatGPT composer exposed duplicate Web search hints");
  if (existing === 1) {
    await captureDiagnostic?.("web-search-hint-already-selected");
    return;
  }

  const plus = page.getByTestId("composer-plus-btn").filter({ visible: true });
  const plusCount = await plus.count();
  if (plusCount === 0) throw new Error("ChatGPT composer plus control is not available; cannot select Web search");
  if (plusCount !== 1) throw new Error("ChatGPT composer exposed duplicate plus controls");
  await plus.focus(options);
  await plus.press("Enter", options);

  const row = page
    .locator(CHATGPT_COMPOSER_MENU_ROW_SELECTOR)
    .filter({ has: page.getByText(CHATGPT_WEB_SEARCH_HINT_LABEL, { exact: true }) })
    .filter({ visible: true });
  try {
    await row.waitFor({ state: "visible", ...options });
  } catch (error) {
    await page.keyboard.press("Escape");
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("ChatGPT composer plus menu did not expose a Web search row");
    }
    throw error;
  }
  if (await row.count() !== 1) {
    await page.keyboard.press("Escape");
    throw new Error("ChatGPT composer plus menu exposed duplicate Web search rows");
  }
  await captureDiagnostic?.("web-search-menu-visible");
  await row.click(options);

  try {
    await hint.waitFor({ state: "visible", ...options });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("ChatGPT composer did not insert the Web search hint");
    }
    throw error;
  }
  if (await hint.count() !== 1) throw new Error("ChatGPT composer exposed duplicate Web search hints");
  await captureDiagnostic?.("web-search-hint-selected");
}
