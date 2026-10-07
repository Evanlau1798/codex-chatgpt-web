import type { Locator } from "playwright-core";
import { ChatGptWebAdapterError } from "./adapter-error";
import {
  chatGptAssistantTurnSelector,
  isTemporaryChatGptTurnUrl,
} from "../../chatgpt-session";

export interface ChatGptAssistantTurnState {
  count: number;
  lastId?: string;
  identities?: readonly string[];
  knownTurnIdentities?: readonly string[];
}

export interface ChatGptAssistantTurnBinding {
  id: string;
  ordinal: number;
  generation: number;
}

export type ChatGptSubmissionEvidence =
  | "user_turn"
  | "assistant_turn"
  | "generation_running"
  | "conversation_navigation"
  | "mcp_tool_call";

export class ChatGptTurnIdentityAmbiguityError extends Error {
  constructor(scope: "assistant" | "conversation", detail = `ChatGPT ${scope} turn identities are ambiguous`) {
    super(detail);
    this.name = "ChatGptTurnIdentityAmbiguityError";
  }
}

export async function activateChatGptSendControl(
  sendButton: Pick<Locator, "press">,
  signal?: AbortSignal,
  onActivate?: () => void,
): Promise<void> {
  // The outer stage owns the budget; submission evidence remains the completion authority.
  onActivate?.();
  await sendButton.press("Enter", { noWaitAfter: true, timeout: 0, signal });
}

export class ChatGptOwnedSendStateUnknownError extends Error {
  constructor(cause: unknown) {
    super("ChatGPT recovery Send may have been submitted before its receipt became unavailable", { cause });
    this.name = "ChatGptOwnedSendStateUnknownError";
  }
}

export interface ChatGptOwnedSendGuard {
  responseSelector: string;
  responseHtml: string;
  stopButtonSelector: string;
  deadlineAt: number;
}

/** Clear only the recovery prompt still owned by this turn. */
export async function clearOwnedChatGptComposerControl(
  composer: Pick<Locator, "evaluate">,
  expectedPrompt: string,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  return composer.evaluate((element, expected) => {
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]')
      .forEach(part => part.remove());
    const observed = [...clone.childNodes].map(child => child.textContent ?? "").join("\n").trimStart();
    if (observed !== expected) return false;
    element.replaceChildren();
    const EventConstructor = element.ownerDocument.defaultView?.Event ?? Event;
    element.dispatchEvent(new EventConstructor("input", { bubbles: true }));
    return true;
  }, expectedPrompt, { signal, timeout: 0 });
}

/** Verify prompt, bound response and generation, then click Send in one renderer task. */
export async function activateOwnedChatGptSendControl(
  composer: Pick<Locator, "evaluate" | "locator">,
  expectedPrompt: string,
  sendButtonSelector: string,
  guard: ChatGptOwnedSendGuard,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const nonce = `recovery-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const installed = await composer.evaluate((element, input) => {
    const validate = (): boolean => {
      if (Date.now() > input.guard.deadlineAt) return false;
      const clone = element.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]')
        .forEach(part => part.remove());
      const observed = [...clone.childNodes].map(child => child.textContent ?? "").join("\n").trimStart();
      if (observed !== input.expectedPrompt) return false;
      const response = element.ownerDocument.querySelectorAll(input.guard.responseSelector);
      if (response.length !== 1 || response[0]!.innerHTML !== input.guard.responseHtml) return false;
      const view = element.ownerDocument.defaultView;
      return ![...element.ownerDocument.querySelectorAll<HTMLElement>(input.guard.stopButtonSelector)]
        .some(candidate => {
          const style = view?.getComputedStyle(candidate);
          return candidate.isConnected && !candidate.hidden && candidate.getAttribute("aria-hidden") !== "true"
            && style?.display !== "none" && style?.visibility !== "hidden";
        });
    };
    if (!validate()) return false;
    const button = element.closest("form")?.querySelector<HTMLElement>(input.sendButtonSelector);
    if (!button || button.getAttribute("aria-disabled") === "true"
      || (button.tagName === "BUTTON" && (button as HTMLButtonElement).disabled)) return false;
    const key = "__codexRecoverySendGuard";
    const registryKey = "__codexRecoverySendGuards";
    type GuardState = { nonce: string; allowed?: boolean; listener?: EventListener; button: HTMLElement };
    const documentRecord = element.ownerDocument as Document & Record<string, unknown>;
    const registry = (documentRecord[registryKey] ??= Object.create(null)) as Record<string, GuardState>;
    const guarded = button as HTMLElement & Record<string, unknown>;
    const previous = guarded[key] as GuardState | undefined;
    if (previous?.listener) button.removeEventListener("click", previous.listener, true);
    if (previous) delete registry[previous.nonce];
    const state: GuardState = { nonce: input.nonce, button };
    const listener: EventListener = event => {
      state.allowed = validate();
      button.removeEventListener("click", listener, true);
      if (button.getAttribute("data-codex-recovery-send") === input.nonce) {
        button.removeAttribute("data-codex-recovery-send");
      }
      if (!state.allowed) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    state.listener = listener;
    registry[input.nonce] = state;
    guarded[key] = state;
    button.setAttribute("data-codex-recovery-send", input.nonce);
    button.addEventListener("click", listener, true);
    return true;
  }, { expectedPrompt, sendButtonSelector, guard, nonce }, { timeout: 0 });
  if (!installed) return false;
  const guardedButton = composer.locator("xpath=ancestor::form[1]")
    .locator(`:is(${sendButtonSelector})[data-codex-recovery-send="${nonce}"]`);
  if (signal?.aborted) {
    await cleanupOwnedSendGuard(composer, nonce);
    signal.throwIfAborted();
  }
  try {
    await guardedButton.click({ noWaitAfter: true, timeout: 0, signal });
  } catch (error) {
    await cleanupOwnedSendGuard(composer, nonce).catch(() => {});
    throw new ChatGptOwnedSendStateUnknownError(error);
  }
  let receipt: boolean | undefined;
  try {
    receipt = await composer.evaluate((element, input) => {
    const key = "__codexRecoverySendGuard";
    const registryKey = "__codexRecoverySendGuards";
    type GuardState = { nonce: string; allowed?: boolean; listener?: EventListener; button: HTMLElement };
    const documentRecord = element.ownerDocument as Document & Record<string, unknown>;
    const registry = documentRecord[registryKey] as Record<string, GuardState> | undefined;
    const state = registry?.[input.nonce];
    if (!state) return undefined;
    delete registry![input.nonce];
    const button = state.button;
    if (state.listener) button.removeEventListener("click", state.listener, true);
    const guarded = button as HTMLElement & Record<string, unknown>;
    if (guarded[key] === state) delete guarded[key];
    if (button.getAttribute("data-codex-recovery-send") === input.nonce) {
      button.removeAttribute("data-codex-recovery-send");
    }
    return state.allowed === true;
    }, { nonce }, { timeout: 0 });
  } catch (error) {
    await cleanupOwnedSendGuard(composer, nonce).catch(() => {});
    throw new ChatGptOwnedSendStateUnknownError(error);
  }
  if (receipt === undefined) {
    throw new ChatGptOwnedSendStateUnknownError(new Error("ChatGPT recovery Send receipt disappeared after click"));
  }
  return receipt;
}

async function cleanupOwnedSendGuard(
  composer: Pick<Locator, "evaluate">,
  nonce: string,
): Promise<void> {
  await composer.evaluate((element, input) => {
    const key = "__codexRecoverySendGuard";
    const registryKey = "__codexRecoverySendGuards";
    type GuardState = { nonce: string; listener?: EventListener; button: HTMLElement };
    const documentRecord = element.ownerDocument as Document & Record<string, unknown>;
    const registry = documentRecord[registryKey] as Record<string, GuardState> | undefined;
    const state = registry?.[input.nonce];
    if (!state) return;
    delete registry![input.nonce];
    const button = state.button;
    if (state.listener) button.removeEventListener("click", state.listener, true);
    const guarded = button as HTMLElement & Record<string, unknown>;
    if (guarded[key] === state) delete guarded[key];
    if (button.getAttribute("data-codex-recovery-send") === input.nonce) {
      button.removeAttribute("data-codex-recovery-send");
    }
  }, { nonce }, { timeout: 0 }).catch(() => {});
}

export async function readChatGptAssistantTurnState(
  turns: Pick<Locator, "evaluateAll">,
): Promise<ChatGptAssistantTurnState> {
  const state = await turns.evaluateAll(elements => {
    const count = elements.length;
    const identities = elements.map(element => {
      const key = element.getAttribute("data-turn-key");
      return key === null ? element.getAttribute("data-turn-id") : `group:assistant:${key}`;
    });
    if (identities.some(identity => typeof identity !== "string" || identity.trim().length === 0)) {
      throw new Error("ChatGPT assistant turn has no stable data-turn-id identity");
    }
    const typed = identities as string[];
    const lastId = typed.at(-1);
    return {
      count,
      identities: typed,
      ambiguous: new Set(typed).size !== typed.length,
      ...(lastId ? { lastId } : {}),
    };
  });
  if (state.ambiguous) throw new ChatGptTurnIdentityAmbiguityError("assistant");
  const { ambiguous: _ambiguous, ...stableState } = state;
  const page = (turns as unknown as Partial<Pick<Locator, "page">>).page?.();
  if (!page) return stableState;
  const knownTurnIdentities = await readChatGptTurnIdentities(
    page.locator("[data-turn-id-container], [data-turn-key]"), "data-turn-id-container",
  );
  const known = new Set(knownTurnIdentities);
  if (stableState.identities.some(identity => !known.has(identity))) {
    // These are separate DOM reads. A remount between them is transient; the
    // caller retries one settled observation and still fails closed if it persists.
    throw new ChatGptTurnIdentityAmbiguityError("assistant", "ChatGPT assistant turn has no matching identity container");
  }
  return { ...stableState, knownTurnIdentities };
}

export async function readChatGptTurnIdentities(
  turns: Pick<Locator, "evaluateAll">,
  attribute = "data-turn-id",
): Promise<string[]> {
  const identities = await turns.evaluateAll((elements, name) => {
    const candidates = name === "data-turn-id-container"
      ? elements.filter(element => element.getAttribute("data-turn-key") !== null
        || (!element.closest("[data-turn-key]") && element.parentElement?.closest("[data-turn-id-container]")
          ?.getAttribute("data-turn-id-container") !== element.getAttribute("data-turn-id-container")))
      : elements;
    const identities = candidates.flatMap(element => {
      const key = element.getAttribute("data-turn-key");
      return key === null ? [element.getAttribute(name)] : name === "data-turn-id-container"
        ? [`group:user:${key}`, `group:assistant:${key}`]
        : [`group:user:${key}`];
    });
    if (identities.some(identity => typeof identity !== "string" || identity.trim().length === 0)) {
      throw new Error(`ChatGPT conversation turn has no stable ${name} identity`);
    }
    return identities as string[];
  }, attribute);
  if (new Set(identities).size !== identities.length) {
    throw new ChatGptTurnIdentityAmbiguityError("conversation");
  }
  return identities;
}

export async function countChatGptTurnRoots(turns: Pick<Locator, "evaluateAll">): Promise<number> {
  return await turns.evaluateAll(elements => elements.filter((element, index) =>
    !elements.some((candidate, candidateIndex) => candidateIndex !== index && candidate.contains(element))).length);
}

export function chatGptNewTurnIdentity(
  initial: readonly string[],
  current: readonly string[],
): string | undefined {
  const previous = new Set(initial);
  const observed = new Set(current);
  const retainedInitial = initial.filter(identity => observed.has(identity));
  const retainedCurrent = current.filter(identity => previous.has(identity));
  if (retainedInitial.length !== retainedCurrent.length
    || retainedInitial.some((identity, index) => identity !== retainedCurrent[index])) {
    throw new Error(`ChatGPT conversation history order changed after Send (initial=${initial.length}, current=${current.length})`);
  }
  // An unchanged retained anchor separates remounted history from post-Send turns.
  // Without one, every unknown identity remains a potential new submission.
  const anchor = retainedInitial.at(-1);
  const boundary = anchor === undefined ? -1 : current.lastIndexOf(anchor);
  const added = current.slice(boundary + 1).filter(identity => !previous.has(identity));
  if (added.length > 1) {
    throw new Error(`ChatGPT exposed ${added.length} new conversation turns for one submitted message`
      + ` (initial=${initial.length}, current=${current.length}, retained=${retainedInitial.length}, beforeAnchor=${boundary + 1})`);
  }
  return added[0];
}

/** Before Send, only history preceding the same terminal anchor may be remounted. */
export function assertChatGptPreSendHistory(initial: readonly string[], current: readonly string[]): void {
  const initialSet = new Set(initial);
  const currentSet = new Set(current);
  const retainedInitial = initial.filter(identity => currentSet.has(identity));
  const retainedCurrent = current.filter(identity => initialSet.has(identity));
  const stable = initial.length === 0 ? current.length === 0
    : current.at(-1) === initial.at(-1)
      && retainedInitial.length === retainedCurrent.length
      && retainedInitial.every((identity, index) => identity === retainedCurrent[index]);
  if (!stable) {
    throw new ChatGptWebAdapterError(
      `ChatGPT history changed before Send (initial=${initial.length}, current=${current.length}); refusing to submit`,
      { status: 502, errorType: "server_error", code: "chatgpt_submission_ambiguous", retryable: false, retireSession: true },
    );
  }
}

export function chatGptReboundTurnIdentity(
  initial: readonly string[],
  boundIdentity: string,
  current: readonly string[],
): string | undefined {
  if (current.includes(boundIdentity)) return boundIdentity;
  return chatGptNewTurnIdentity(initial, current);
}

export function chatGptAssistantTurnChanged(
  initial: ChatGptAssistantTurnState,
  current: ChatGptAssistantTurnState,
): boolean {
  if (current.identities && (initial.knownTurnIdentities || initial.identities)) {
    return chatGptNewTurnIdentity(initial.knownTurnIdentities ?? initial.identities!, current.identities) !== undefined;
  }
  if (current.count < initial.count || current.count < 1) return false;
  if (current.count > initial.count) {
    return !initial.lastId || Boolean(current.lastId && current.lastId !== initial.lastId);
  }
  return Boolean(initial.lastId && current.lastId && current.lastId !== initial.lastId);
}

export function bindChatGptAssistantTurn(
  initial: ChatGptAssistantTurnState,
  current: ChatGptAssistantTurnState,
): ChatGptAssistantTurnBinding | undefined {
  if (!chatGptAssistantTurnChanged(initial, current) || current.count < 1 || !current.lastId) return undefined;
  const identity = current.identities && (initial.knownTurnIdentities || initial.identities)
    ? chatGptNewTurnIdentity(initial.knownTurnIdentities ?? initial.identities!, current.identities)
    : current.lastId;
  if (!identity) return undefined;
  return {
    id: identity,
    ordinal: current.identities?.indexOf(identity) ?? current.count - 1,
    generation: 0,
  };
}

export function reconcileChatGptAssistantTurnBinding(
  initial: ChatGptAssistantTurnState,
  current: ChatGptAssistantTurnState,
  binding: ChatGptAssistantTurnBinding,
  attached: boolean,
): ChatGptAssistantTurnBinding | undefined {
  if (attached) return binding;
  if (current.count < 1 || !current.lastId) return undefined;
  if (current.identities?.includes(binding.id) || current.lastId === binding.id) {
    return { ...binding, ordinal: current.identities?.indexOf(binding.id) ?? current.count - 1 };
  }
  if (!chatGptAssistantTurnChanged(initial, current)) return undefined;
  return {
    id: current.lastId,
    ordinal: current.count - 1,
    generation: binding.generation + 1,
  };
}

export function locateChatGptAssistantTurn(
  turns: Locator,
  binding: ChatGptAssistantTurnBinding,
): Locator {
  return turns.page().locator(chatGptAssistantTurnSelector(binding.id));
}

export function chatGptSubmissionEvidence(state: {
  initialUserTurnCount: number;
  userTurnCount: number;
  initialAssistantTurnCount: number;
  assistantTurnCount: number;
  initialAssistantTurnId?: string;
  assistantTurnId?: string;
  initialTurnIdentities?: readonly string[];
  userIdentities?: readonly string[];
  responseIdentities?: readonly string[];
  generationRunning: boolean;
  initialPageUrl?: string;
  currentPageUrl?: string;
  composerTextLength?: number;
  submissionRequestObserved?: boolean;
}): ChatGptSubmissionEvidence | undefined {
  if (state.initialTurnIdentities && state.userIdentities && state.responseIdentities) {
    if (chatGptNewTurnIdentity(state.initialTurnIdentities, state.userIdentities)) return "user_turn";
    if (chatGptNewTurnIdentity(state.initialTurnIdentities, state.responseIdentities)) return "assistant_turn";
    if (state.generationRunning) return "generation_running";
    return freshTemporaryChatNavigationAccepted(state) ? "conversation_navigation" : undefined;
  }
  if (state.userTurnCount > state.initialUserTurnCount) return "user_turn";
  if (chatGptAssistantTurnChanged(
    { count: state.initialAssistantTurnCount, ...(state.initialAssistantTurnId ? { lastId: state.initialAssistantTurnId } : {}) },
    { count: state.assistantTurnCount, ...(state.assistantTurnId ? { lastId: state.assistantTurnId } : {}) },
  )) return "assistant_turn";
  if (state.generationRunning) return "generation_running";
  if (freshTemporaryChatNavigationAccepted(state)) return "conversation_navigation";
  return undefined;
}

function freshTemporaryChatNavigationAccepted(state: {
  initialPageUrl?: string;
  currentPageUrl?: string;
  composerTextLength?: number;
  submissionRequestObserved?: boolean;
}): boolean {
  return state.composerTextLength === 0
    && state.submissionRequestObserved === true
    && typeof state.initialPageUrl === "string"
    && typeof state.currentPageUrl === "string"
    && isExactTemporaryChatGptRootUrl(state.initialPageUrl)
    && isTemporaryChatGptTurnUrl(state.currentPageUrl);
}

function isExactTemporaryChatGptRootUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://chatgpt.com"
      && url.pathname === "/"
      && url.search === "?temporary-chat=true"
      && url.hash === "";
  } catch {
    return false;
  }
}
