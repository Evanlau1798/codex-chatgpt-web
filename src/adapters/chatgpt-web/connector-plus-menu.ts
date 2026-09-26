import type { Locator, Page } from "playwright-core";

export const CHATGPT_CONNECTOR_MENTION_ROW_SELECTOR =
  '.__menu-item[tabindex="0"], [data-mention-list-scroll-area] button[data-list-navigation-item="true"]';

export const CHATGPT_SELECTED_CONNECTOR_SELECTOR =
  '[data-id^="plugin:"][data-keyword], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]';

export async function chatGptConnectorMentionRowHighlighted(
  row: Locator,
  options: { signal?: AbortSignal; timeout?: number } = {},
): Promise<boolean> {
  return await row.getAttribute("data-highlighted", options) !== null
    || await row.getAttribute("aria-current", options) === "true";
}

const CONNECTOR_MENU_TIMEOUT_MS = 2_500;

export async function openChatGptConnectorPlusMenu(
  page: Page,
  appName: string,
  signal?: AbortSignal,
): Promise<Locator | undefined> {
  const plus = page.getByTestId("composer-plus-btn").filter({ visible: true });
  const plusCount = await plus.count();
  if (plusCount === 0) return undefined;
  if (plusCount !== 1) throw new Error("ChatGPT composer exposed duplicate plus controls");

  await plus.focus({ signal, timeout: CONNECTOR_MENU_TIMEOUT_MS });
  await plus.press("Enter", { signal, timeout: CONNECTOR_MENU_TIMEOUT_MS });
  const row = page.getByRole("menuitemradio", { name: appName, exact: true }).filter({ visible: true });
  try {
    await row.waitFor({ state: "visible", timeout: CONNECTOR_MENU_TIMEOUT_MS, signal });
  } catch (error) {
    await page.keyboard.press("Escape");
    if (error instanceof Error && error.name === "TimeoutError") return undefined;
    throw error;
  }
  if (await row.count() !== 1) {
    await page.keyboard.press("Escape");
    throw new Error(`ChatGPT connector plus menu exposed duplicate ${JSON.stringify(appName)} rows`);
  }
  await row.focus({ signal, timeout: CONNECTOR_MENU_TIMEOUT_MS });
  return row;
}
