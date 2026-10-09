import { activateChatGptEffortMenu, parseChatGptEffortSliderState, parseChatGptModelAnnouncement, readChatGptModelAnnouncements } from "../../chatgpt-session";
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
      // Keep the old localized Latest labels and the explicit current version.
      : /^(?:Latest|Le plus récent|最新(?:模型)?|최신|(?:GPT[-\s]?)?6(?:\s+Astra)?(?:\s+Pro)?)$/i,
    exact: true,
    includeHidden: true,
  });
}

/** Model and effort are separate browser controls; a generic Pro label proves neither family. */
export async function selectChatGptModelFamily(
  menu: EffortMenu,
  family: ChatGptWebModelFamily,
  activate: () => Promise<EffortMenu>,
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
        const trigger = powerView.locator('[data-model-picker-view-toggle="true"]:not([aria-hidden="true"])').filter({ visible: true });
        if (await trigger.count() !== 1) throw familyError(family);
        await trigger.click({ timeout: 5_000 });
      } else if (view !== "advanced") throw familyError(family);
    } else {
      const trigger = menu.menu.locator('[role="menuitem"][aria-expanded][data-model-picker-view-toggle="true"]:not([aria-hidden="true"]), [role="menuitem"][aria-expanded][aria-hidden="false"]').filter({ visible: true });
      if (await powerView.count() !== 0 || await trigger.count() !== 1) throw familyError(family);
      if (await trigger.getAttribute("aria-expanded") === "false") await trigger.click({ timeout: 5_000 });
    }
    await option.waitFor({ state: "visible", timeout: 5_000 });
    await option.click({ timeout: 5_000 });
    // Choosing a family returns the open picker to its slider. Keep that surface:
    // Escape followed by an immediate reopen races the outgoing menu's cleanup.
    // Activation reuses the open menu and verifies its owner before returning it.
    const selected = await activate();
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
  // GPT-6 uses Sol below Pro and Astra at Pro. An old Latest picker can still use
  // 5.6 at lower efforts; that is not proof of an explicitly requested GPT-6 turn.
  const expectedName = family === "6" && effort === "max" ? "astra" : "sol";
  const states = descriptions.flatMap(text => {
    const state = parseChatGptModelAnnouncement(text);
    return state ? [state] : [];
  });
  return states.length > 0 && states.every(state => state.version === family
    && (!state.name || state.name === expectedName)
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
    const descriptions = await readChatGptModelAnnouncements(menu.slider);
    // The retired Latest picker used 5.6 below Pro. Only its actual radio label authorizes
    // that compatibility mapping; an explicit 6 picker must prove 6 at every effort.
    const legacyLatest = family === "6" && checked && effort !== "max"
      && /^(?:Latest|Le plus récent|最新(?:模型)?|최신)$/i.test((await option.innerText()).trim());
    const expectedFamily = legacyLatest ? "5.6" : family;
    if (checked && state && state.value === state.min + effortIndex && (chatGptModelFamilyMatches(descriptions, expectedFamily, effort)
      || (family === "5.6" && chatGptUnversionedEffortMatches(descriptions, effort)))) return;
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
