import type { Locator, Page } from "playwright-core";

const CONNECTOR_MENU_TIMEOUT_MS = 2_500;

export async function openChatGptConnectorPlusMenu(
  page: Page,
  appName: string,
): Promise<Locator | undefined> {
  const plus = page.getByTestId("composer-plus-btn").filter({ visible: true });
  const plusCount = await plus.count();
  if (plusCount === 0) return undefined;
  if (plusCount !== 1) throw new Error("ChatGPT composer exposed duplicate plus controls");

  await plus.focus();
  await page.keyboard.press("Enter");
  const row = page.getByRole("menuitemradio", { name: appName, exact: true }).filter({ visible: true });
  try {
    await row.waitFor({ state: "visible", timeout: CONNECTOR_MENU_TIMEOUT_MS });
  } catch (error) {
    await page.keyboard.press("Escape");
    if (error instanceof Error && error.name === "TimeoutError") return undefined;
    throw error;
  }
  if (await row.count() !== 1) {
    await page.keyboard.press("Escape");
    throw new Error(`ChatGPT connector plus menu exposed duplicate ${JSON.stringify(appName)} rows`);
  }
  return row;
}
