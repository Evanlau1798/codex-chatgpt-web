import type { Locator, Page } from "playwright-core";
import {
  ChatGptBrowserMutationDeadlineError,
  ChatGptPersistentBrowserStateError,
  remainingChatGptMutationMs,
  runChatGptMutationCleanup,
  runChatGptOwnedMutationStep,
  runChatGptMutationStep,
  waitForChatGptMutationPoll,
} from "../../browser-mutation";
import { ChatGptWebAdapterError } from "./adapter-error";

const CONTROL_SELECTOR = [
  '[data-testid="thread-header-right-actions"] [aria-haspopup="menu"]',
  '#conversation-header-actions [aria-haspopup="menu"]',
  '[data-content-sheet-root] > button[aria-expanded][aria-controls]',
].join(", ");
const CHOICE_SELECTOR = '[role="menuitemradio"], [role="radio"]';
const PREFLIGHT_TIMEOUT_MS = 30_000;
const UI_SETTLE_MS = 250;

type ChoiceIndex = 0 | 1;
type ToggleReceipt = { originalIndex: ChoiceIndex };
type StructuralState = { menu: Locator; choices: Locator; checkedIndex: ChoiceIndex };

export type ChatGptPersonalizationPreflight = "already-personalized" | "enabled";

function unavailable(message: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(message, {
    status: 424,
    errorType: "connector_error",
    code: "connector_not_found",
    retryable: false,
  });
}

async function pressEscape(page: Page, signal: AbortSignal): Promise<void> {
  await page.locator("body").press("Escape", { timeout: 5_000, signal });
}

async function dismissMenu(page: Page): Promise<void> {
  await runChatGptMutationCleanup(signal => pressEscape(page, signal));
}

async function ownedMenu(
  page: Page,
  control: Locator,
  deadline: number,
  signal: AbortSignal,
): Promise<Locator> {
  let menuId: string | null = null;
  while (!menuId) {
    const remaining = remainingChatGptMutationMs(deadline, signal);
    menuId = await control.getAttribute("aria-controls", { timeout: remaining, signal });
    if (!menuId) await waitForChatGptMutationPoll(Math.min(50, remaining), signal);
  }
  const menu = page.locator(`[id=${JSON.stringify(menuId)}]`);
  try {
    await menu.waitFor({ state: "visible", timeout: remainingChatGptMutationMs(deadline, signal), signal });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    throw unavailable("ChatGPT personalization control did not expose its owned menu before the readiness deadline");
  }
  return menu;
}

async function checkedIndex(
  choices: Locator,
  deadline: number,
  signal: AbortSignal,
): Promise<ChoiceIndex> {
  const checked: boolean[] = [];
  for (let index = 0; index < 2; index += 1) {
    const choice = choices.nth(index);
    const options = { timeout: remainingChatGptMutationMs(deadline, signal), signal };
    const ariaChecked = await choice.getAttribute("aria-checked", options);
    const dataState = await choice.getAttribute("data-state", options);
    checked.push(ariaChecked === "true" || dataState === "checked");
  }
  if (checked.filter(Boolean).length !== 1) {
    throw unavailable("ChatGPT personalization menu did not expose one checked state");
  }
  return checked[0] ? 0 : 1;
}

async function openStructuralState(
  page: Page,
  deadline: number,
  signal: AbortSignal,
): Promise<StructuralState> {
  const controls = page.locator(CONTROL_SELECTOR).filter({ visible: true });
  const control = controls.first();
  try {
    await control.waitFor({ state: "visible", timeout: remainingChatGptMutationMs(deadline, signal), signal });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    throw unavailable("ChatGPT Temporary Chat did not expose a structural personalization control before the readiness deadline");
  }
  if (await runChatGptMutationStep(() => controls.count(), deadline, signal) !== 1) {
    throw unavailable("ChatGPT Temporary Chat did not expose exactly one structural personalization control");
  }
  await control.click({ timeout: remainingChatGptMutationMs(deadline, signal), signal });
  const menu = await ownedMenu(page, control, deadline, signal);
  const choices = menu.locator(CHOICE_SELECTOR).filter({ visible: true });
  if (await runChatGptMutationStep(() => choices.count(), deadline, signal) !== 2) {
    throw unavailable("ChatGPT personalization menu did not expose exactly two checkable states");
  }
  return { menu, choices, checkedIndex: await checkedIndex(choices, deadline, signal) };
}

async function restoreChoice(page: Page, receipt: ToggleReceipt): Promise<void> {
  await runChatGptMutationCleanup(async signal => {
    await pressEscape(page, signal);
    const deadline = Date.now() + 5_000;
    let state = await openStructuralState(page, deadline, signal);
    if (state.checkedIndex === receipt.originalIndex) {
      await pressEscape(page, signal);
      return;
    }
    await state.choices.nth(receipt.originalIndex).click({ timeout: 5_000, signal });
    await state.menu.waitFor({ state: "hidden", timeout: 5_000, signal });
    await waitForChatGptMutationPoll(UI_SETTLE_MS, signal);
    state = await openStructuralState(page, deadline, signal);
    if (state.checkedIndex !== receipt.originalIndex) {
      throw new Error("ChatGPT personalization rollback did not restore the original checked state");
    }
    await pressEscape(page, signal);
  });
}

async function toggleChoice(
  page: Page,
  deadline: number,
  signal: AbortSignal,
): Promise<ToggleReceipt> {
  let receipt: ToggleReceipt | undefined;
  try {
    const state = await openStructuralState(page, deadline, signal);
    receipt = { originalIndex: state.checkedIndex };
    const nextIndex: ChoiceIndex = state.checkedIndex === 0 ? 1 : 0;
    await state.choices.nth(nextIndex).click({ timeout: remainingChatGptMutationMs(deadline, signal), signal });
    await state.menu.waitFor({ state: "hidden", timeout: remainingChatGptMutationMs(deadline, signal), signal });
    await waitForChatGptMutationPoll(UI_SETTLE_MS, signal);
    return receipt;
  } catch (error) {
    try {
      if (receipt) await restoreChoice(page, receipt);
      else await dismissMenu(page);
    } catch (cleanupError) {
      throw new ChatGptPersistentBrowserStateError(
        [error, cleanupError],
        "ChatGPT personalization change failed and its original state could not be restored",
      );
    }
    throw error;
  }
}

async function ensureWithinDeadline(
  page: Page,
  deadline: number,
  signal: AbortSignal,
  captureDiagnostic?: (checkpoint: string) => Promise<void>,
  proveConnectorAccess?: (signal: AbortSignal) => Promise<boolean>,
): Promise<ChatGptPersonalizationPreflight> {
  const capture = async (checkpoint: string) => {
    if (captureDiagnostic) await runChatGptMutationStep(() => captureDiagnostic(checkpoint), deadline, signal);
  };
  const prove = async () => proveConnectorAccess
    ? runChatGptOwnedMutationStep(() => proveConnectorAccess(signal), deadline, signal)
    : false;
  const personalized = page.getByRole("button", { name: "Personalized", exact: true, includeHidden: true }).filter({ visible: true });
  const unpersonalized = page.getByRole("button", { name: "Unpersonalized", exact: true, includeHidden: true }).filter({ visible: true });
  let personalizedCount = await runChatGptMutationStep(() => personalized.count(), deadline, signal);
  let unpersonalizedCount = await runChatGptMutationStep(() => unpersonalized.count(), deadline, signal);
  if (personalizedCount === 0 && unpersonalizedCount === 0) {
    await waitForChatGptMutationPoll(UI_SETTLE_MS, signal);
    personalizedCount = await runChatGptMutationStep(() => personalized.count(), deadline, signal);
    unpersonalizedCount = await runChatGptMutationStep(() => unpersonalized.count(), deadline, signal);
    if (personalizedCount === 0 && unpersonalizedCount === 0) {
      if (await prove()) {
        await capture("personalization-already-enabled");
        return "already-personalized";
      }
      await capture("personalization-unpersonalized");
      const receipt = await toggleChoice(page, deadline, signal);
      let proofError: unknown;
      try {
        if (await prove()) {
          await capture("personalization-enabled");
          return "enabled";
        }
      } catch (error) {
        proofError = error;
      }
      try {
        await restoreChoice(page, receipt);
      } catch (restoreError) {
        throw new ChatGptPersistentBrowserStateError(
          proofError === undefined ? [restoreError] : [proofError, restoreError],
          "ChatGPT personalization could not prove connector access or restore its original state",
        );
      }
      if (proofError !== undefined) throw proofError;
      throw unavailable("The configured ChatGPT connector remained unavailable after personalization changed");
    }
  }
  if (personalizedCount === 1 && unpersonalizedCount === 0) {
    await capture("personalization-already-enabled");
    return "already-personalized";
  }
  if (personalizedCount !== 0 || unpersonalizedCount !== 1) {
    throw unavailable(`ChatGPT exposed an invalid Temporary Chat personalization state (personalized=${personalizedCount}, unpersonalized=${unpersonalizedCount})`);
  }

  await capture("personalization-unpersonalized");
  await unpersonalized.click({ timeout: remainingChatGptMutationMs(deadline, signal), signal });
  try {
    const menu = await ownedMenu(page, unpersonalized, deadline, signal);
    const choice = menu.locator(CHOICE_SELECTOR).filter({ hasText: /^Personalized/ });
    if (await runChatGptMutationStep(() => choice.count(), deadline, signal) !== 1) {
      throw unavailable("ChatGPT personalization menu did not expose one exact Personalized choice");
    }
    await choice.click({ timeout: remainingChatGptMutationMs(deadline, signal), signal });
    await personalized.waitFor({ state: "visible", timeout: remainingChatGptMutationMs(deadline, signal), signal });
    await unpersonalized.waitFor({ state: "hidden", timeout: remainingChatGptMutationMs(deadline, signal), signal });
  } catch (error) {
    try { await dismissMenu(page); }
    catch (cleanupError) {
      throw new ChatGptPersistentBrowserStateError(
        [error, cleanupError],
        "ChatGPT labeled personalization change failed and its menu could not be closed",
      );
    }
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    throw unavailable("ChatGPT did not confirm Personalized connector access for this Temporary Chat");
  }
  await capture("personalization-enabled");
  return "enabled";
}

export async function ensureChatGptPersonalizedConnectorAccess(
  page: Page,
  captureDiagnostic?: (checkpoint: string) => Promise<void>,
  proveConnectorAccess?: (signal: AbortSignal) => Promise<boolean>,
  abortSignal?: AbortSignal,
): Promise<ChatGptPersonalizationPreflight> {
  const deadline = Date.now() + PREFLIGHT_TIMEOUT_MS;
  const deadlineController = new AbortController();
  const timer = setTimeout(() => deadlineController.abort(), PREFLIGHT_TIMEOUT_MS);
  timer.unref?.();
  const signal = abortSignal
    ? AbortSignal.any([abortSignal, deadlineController.signal])
    : deadlineController.signal;
  try {
    return await ensureWithinDeadline(page, deadline, signal, captureDiagnostic, proveConnectorAccess);
  } catch (error) {
    if (error instanceof ChatGptPersistentBrowserStateError) throw error;
    if (!abortSignal?.aborted && (
      error instanceof ChatGptBrowserMutationDeadlineError
      || deadlineController.signal.aborted
      || Date.now() >= deadline
    )) {
      throw unavailable("ChatGPT personalization preflight exceeded its readiness deadline");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
