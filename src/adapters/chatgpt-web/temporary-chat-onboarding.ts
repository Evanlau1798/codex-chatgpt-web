import type { Locator, Page } from "playwright-core";

const onboardingDialog = (page: Page): Locator => page
  .locator('[role="dialog"]')
  .filter({ hasText: "Not in history" })
  .filter({ hasText: "No model training" })
  .filter({ hasText: "Memory off" })
  .last();

export async function dismissChatGptTemporaryChatOnboarding(page: Page): Promise<boolean> {
  const dialog = onboardingDialog(page);
  if (!await dialog.isVisible().catch(() => false)) return false;
  const continueButton = dialog.getByRole("button", { name: "Continue", exact: true }).last();
  if (!await continueButton.isVisible().catch(() => false)) {
    throw new Error("ChatGPT Temporary Chat onboarding is visible without its Continue action");
  }
  await continueButton.click({ force: true });
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  return true;
}
