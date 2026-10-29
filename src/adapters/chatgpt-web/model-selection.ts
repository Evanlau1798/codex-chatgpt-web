import {
  type ChatGptEffortActivation,
  chatGptModelOption,
  openChatGptModelRows,
  parseChatGptEffortSliderState,
  parseChatGptModelAnnouncement,
  readChatGptModelAnnouncements,
} from "../../chatgpt-ui/model-picker";
import { normalizeChatGptModelAnnouncement } from "../../chatgpt-session";
import type { ChatGptWebAdapterEffort, ChatGptWebModelFamily } from "../../chatgpt-web-models";
import { ChatGptWebAdapterError } from "./adapter-error";

type EffortMenu = ChatGptEffortActivation;

const effortLabels: Record<ChatGptWebAdapterEffort, RegExp> = {
  low: /^(?:Instant|Instantané|即時)$/i,
  medium: /^(?:Medium|Moyen|中)$/i,
  high: /^(?:High|Élevée?|Elevée?|高)$/i,
  xhigh: /^(?:Extra High|Très élevé|極高)$/i,
  max: /^(?:Pro|Max)$/i,
};

function effortPosition(text: string): RegExpExecArray | null {
  return /\p{P}\s*(\d+)\s+(?:of|sur)\s+(\d+)\p{P}*$/iu.exec(text.trim())
    ?? /\p{P}\s*第\s*(\d+)\s*項\p{P}\s*共\s*(\d+)\s*項\p{P}*$/iu.exec(text.trim());
}

function matchesEffortPosition(position: RegExpExecArray, effort: ChatGptWebAdapterEffort): boolean {
  const index = ["low", "medium", "high", "xhigh", "max"].indexOf(effort) + 1;
  return Number(position[1]) === index && Number(position[2]) >= index && Number(position[2]) <= 6;
}

function effortEvidenceMatches(descriptions: readonly string[], effort: ChatGptWebAdapterEffort): boolean {
  return descriptions.every(text => {
    const normalized = normalizeChatGptModelAnnouncement(text);
    const mode = parseChatGptModelAnnouncement(normalized)?.mode ?? normalized.split(/\p{P}/u)[0]!.trim();
    const recognized = Object.values(effortLabels).some(label => label.test(mode));
    const position = effortPosition(normalized);
    return (!recognized || effortLabels[effort].test(mode))
      && (!position || matchesEffortPosition(position, effort));
  });
}

function modelVersionEvidenceMatches(descriptions: readonly string[], family: ChatGptWebModelFamily): boolean {
  return descriptions.every(text => {
    const version = /^(?:GPT[-\s]?)?(\d+(?:\.\d+)*)/i.exec(normalizeChatGptModelAnnouncement(text));
    return !version || version[1] === family;
  });
}

function familyError(family: ChatGptWebModelFamily, cause?: unknown): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `ChatGPT model ${family} could not be selected and verified. The pending message was not sent. Check the model in the browser; if ChatGPT uses an unsupported language, select English in Settings → General → Language and reload it.`,
    { status: 400, errorType: "invalid_request_error", code: "model_version_unavailable", retryable: false, cause },
  );
}

export function familyOption(menu: EffortMenu, family: ChatGptWebModelFamily, effort?: ChatGptWebAdapterEffort) {
  return chatGptModelOption(menu.menu, {
    version: family, name: family === "6" && effort === "max" ? "astra" : "sol",
  });
}

/** Model and effort are separate browser controls; a generic Pro label proves neither family. */
export async function selectChatGptModelFamily(
  menu: EffortMenu,
  family: ChatGptWebModelFamily,
  activate: () => Promise<EffortMenu>,
  effort?: ChatGptWebAdapterEffort,
): Promise<EffortMenu> {
  try {
    const option = await familyOption(menu, family, effort);
    if (await option.count() > 1) throw familyError(family);
    if (await option.count() === 1 && await option.getAttribute("aria-checked") === "true") return menu;
    await openChatGptModelRows(menu.menu);
    await option.waitFor({ state: "visible", timeout: 5_000 });
    await option.click({ timeout: 5_000 });
    // Choosing a family returns the open picker to its slider. Keep that surface:
    // Escape followed by an immediate reopen races the outgoing menu's cleanup.
    // Activation reuses the open menu and verifies its owner before returning it.
    const selected = await activate();
    const deadline = Date.now() + 1_000;
    do {
      const current = await familyOption(selected, family, effort);
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
  return modelVersionEvidenceMatches(descriptions, family) && states.length > 0 && states.every(state => state.version === family
    && (!state.name || state.name === expectedName)
    && (!/^max$/i.test(state.mode) || family === "6" && effort === "max" && state.name === "astra")
    && (effortLabels[effort].test(state.mode)
      || family === "6" && effort === "max" && state.name === "astra" && /^max$/i.test(state.mode)))
    && effortEvidenceMatches(descriptions, effort);
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
    const option = await familyOption(menu, family, effort);
    const checked = await option.count() === 1 && await option.getAttribute("aria-checked") === "true";
    const state = parseChatGptEffortSliderState(
      await menu.slider.getAttribute("aria-valuemin"), await menu.slider.getAttribute("aria-valuemax"),
      await menu.slider.getAttribute("aria-valuenow"),
    );
    const descriptions = await readChatGptModelAnnouncements(menu.slider);
    // The retired Latest picker used 5.6 below Pro. Only its actual radio label authorizes
    // that compatibility mapping; an explicit 6 picker must prove 6 at every effort.
    const legacyLatest = family === "6" && checked
      && /^(?:Latest|Le plus récent|最新(?:模型)?|최신)$/i.test((await option.innerText()).trim());
    const expectedFamily = legacyLatest && effort !== "max" ? "5.6" : family;
    if (checked && state && state.value === state.min + effortIndex && modelVersionEvidenceMatches(descriptions, expectedFamily)
      && (chatGptModelFamilyMatches(descriptions, expectedFamily, effort)
      || (!legacyLatest && chatGptUnversionedEffortMatches(descriptions, effort)))) return;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (true);
  throw familyError(family);
}

/** Current pickers omit the version in their status. The caller must also verify the family radio,
 * all version evidence and slider position; an unscoped generic Pro label is never sufficient evidence. */
export function chatGptUnversionedEffortMatches(descriptions: readonly string[], effort: ChatGptWebAdapterEffort): boolean {
  const normalized = descriptions.map(normalizeChatGptModelAnnouncement);
  if (!effortEvidenceMatches(normalized, effort)) return false;
  if (normalized.some(text => /^(?:GPT[-\s]?)?\d+(?:\.\d+)?\s/i.test(text))) return false;
  const statuses = normalized.flatMap(text => {
    const position = effortPosition(text);
    return position ? [{ label: text.slice(0, position.index).trim(), position }] : [];
  });
  return statuses.length === 1 && effortLabels[effort].test(statuses[0]!.label)
    && matchesEffortPosition(statuses[0]!.position, effort);
}
