import type { Page } from "playwright-core";
import { activateChatGptEffortMenu, parseChatGptEffortSliderState } from "../../chatgpt-session";
import type { ChatGptWebAdapterEffort, ChatGptWebModelFamily } from "../../chatgpt-web-models";
import { ChatGptWebAdapterError } from "./adapter-error";

type EffortMenu = Awaited<ReturnType<typeof activateChatGptEffortMenu>>;

function familyError(family: ChatGptWebModelFamily, cause?: unknown): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `ChatGPT model ${family} could not be selected and verified. The pending message was not sent. Check the model in the browser; if ChatGPT uses an unsupported language, select English in Settings → General → Language and reload it.`,
    { status: 400, errorType: "invalid_request_error", code: "model_version_unavailable", retryable: false, cause },
  );
}

export function familyOption(menu: EffortMenu, family: ChatGptWebModelFamily) {
  return menu.menu.getByRole("menuitemradio", {
    name: family === "5.6" ? /^GPT[-\s]?5\.6\s+Sol(?:\s+Pro)?$/i
      // Match the localized Latest label using the same anchored selector in every language.
      : /^(?:Latest|Le plus récent|最新|최신|GPT[-\s]?6(?:\s+Astra)?(?:\s+Pro)?)$/i,
    exact: true,
    includeHidden: true,
  });
}

/** Model and effort are separate browser controls; a generic Pro label proves neither family. */
export async function selectChatGptModelFamily(
  page: Page,
  menu: EffortMenu,
  family: ChatGptWebModelFamily,
  reopen: () => Promise<EffortMenu>,
): Promise<EffortMenu> {
  try {
    const option = familyOption(menu, family);
    if (await option.count() > 1) throw familyError(family);
    if (await option.count() === 1 && await option.getAttribute("aria-checked") === "true") return menu;
    // The attached radio rows are inert while this composer-owned advanced view is collapsed.
    const powerView = menu.menu.locator('[data-model-picker-view]');
    if (await powerView.count() === 1) {
      const view = await powerView.getAttribute("data-model-picker-view");
      if (view === "simple") {
        const trigger = powerView.locator('[data-model-picker-view-toggle="true"][aria-hidden="false"]');
        if (await trigger.count() !== 1) throw familyError(family);
        await trigger.click({ timeout: 5_000 });
      } else if (view !== "advanced") throw familyError(family);
    } else {
      const trigger = menu.menu.locator('[role="menuitem"][aria-expanded][aria-hidden="false"]');
      if (await powerView.count() !== 0 || await trigger.count() !== 1) throw familyError(family);
      if (await trigger.getAttribute("aria-expanded") === "false") await trigger.click({ timeout: 5_000 });
    }
    await option.waitFor({ state: "visible", timeout: 5_000 });
    await option.click({ timeout: 5_000 });
    await page.keyboard.press("Escape");
    // Do not reopen a menu that is still committing its close animation.
    await menu.menu.waitFor({ state: "hidden", timeout: 5_000 });
    const selected = await reopen();
    const deadline = Date.now() + 1_000;
    do {
      const current = familyOption(selected, family);
      if (await current.count() > 1) throw familyError(family);
      if (await current.count() === 1 && await current.getAttribute("aria-checked") === "true") return selected;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw familyError(family);
  } catch (cause) {
    if (cause instanceof ChatGptWebAdapterError) throw cause;
    throw familyError(family, cause);
  }
}

export function chatGptModelFamilyMatches(
  descriptions: readonly string[],
  family: ChatGptWebModelFamily,
  effort: ChatGptWebAdapterEffort,
): boolean {
  // Latest uses 5.6 for the existing lower-effort multipart acknowledgements and 6 for Pro.
  // Never interpret a future Latest Pro model as 6, or a lower effort as the final Pro response.
  const expected = family === "6" && effort !== "max" ? "5.6" : family;
  const states = descriptions.flatMap(text => {
    const match = /^(?:GPT[-\s]?)?(\d+(?:\.\d+)?)(?:\s+(Sol|Astra))?\s+([^,，]+)(?:[,，]|$)/i
      .exec(text.replace(/\s+/g, " ").trim());
    return match ? [{ version: match[1], name: match[2]?.toLowerCase(), mode: match[3]!.trim() }] : [];
  });
  return states.length > 0 && states.every(state => state.version === expected
    && (!state.name || state.name === (expected === "5.6" ? "sol" : "astra"))
    && (effort === "max" ? /^Pro$/i.test(state.mode) : !/^Pro$/i.test(state.mode)));
}

export async function assertChatGptModelFamily(
  menu: EffortMenu,
  family: ChatGptWebModelFamily,
  effort: ChatGptWebAdapterEffort,
  effortIndex: number,
  settleMs = 0,
): Promise<void> {
  const deadline = Date.now() + settleMs;
  do {
    const option = familyOption(menu, family);
    const checked = await option.count() === 1 && await option.getAttribute("aria-checked") === "true";
    const state = parseChatGptEffortSliderState(
      await menu.slider.getAttribute("aria-valuemin"), await menu.slider.getAttribute("aria-valuemax"),
      await menu.slider.getAttribute("aria-valuenow"),
    );
    const descriptions = await menu.slider.locator("xpath=ancestor::*[@role='menuitem'][1]").evaluate(element => (
      (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)
        .map(id => element.ownerDocument.getElementById(id)?.textContent ?? "")
    ));
    if (checked && state && state.value === state.min + effortIndex && (chatGptModelFamilyMatches(descriptions, family, effort)
      || chatGptUnversionedEffortMatches(descriptions, effort))) return;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (true);
  throw familyError(family);
}

/** Current pickers omit the version in their status. The caller must also verify the family radio
 * and slider position; an unscoped generic Pro label is never sufficient evidence. */
export function chatGptUnversionedEffortMatches(descriptions: readonly string[], effort: ChatGptWebAdapterEffort): boolean {
  if (descriptions.some(text => /^(?:GPT[-\s]?)?\d+(?:\.\d+)?\s/i.test(text.trim()))) return false;
  const labels: Record<ChatGptWebAdapterEffort, RegExp> = {
    low: /^(?:Instant|Instantané)$/i,
    medium: /^(?:Medium|Moyen)$/i,
    high: /^(?:High|Élevée?|Elevée?)$/i,
    xhigh: /^(?:Extra High|Très élevé)$/i,
    max: /^Pro$/i,
  };
  const statuses = descriptions.map(text => /^(.*?),\s*([1-5])\s+(?:of|sur)\s+([1-5])\.$/i.exec(text.trim())).filter(Boolean);
  const index = ["low", "medium", "high", "xhigh", "max"].indexOf(effort) + 1;
  return statuses.length === 1 && labels[effort].test(statuses[0]![1]!)
    && Number(statuses[0]![2]) === index && Number(statuses[0]![3]) >= index;
}
