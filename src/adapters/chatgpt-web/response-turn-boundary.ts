import type { Locator } from "playwright-core";

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
  | "mcp_tool_call";

export async function activateChatGptSendControl(
  sendButton: Pick<Locator, "press">,
  signal?: AbortSignal,
): Promise<void> {
  // The outer stage owns the budget; submission evidence remains the completion authority.
  await sendButton.press("Enter", { noWaitAfter: true, timeout: 0, signal });
}

export async function readChatGptAssistantTurnState(
  turns: Pick<Locator, "evaluateAll">,
): Promise<ChatGptAssistantTurnState> {
  const state = await turns.evaluateAll(elements => {
    const count = elements.length;
    const identities = elements.map(element => element.getAttribute("data-turn-id"));
    if (identities.some(identity => typeof identity !== "string" || identity.trim().length === 0)) {
      throw new Error("ChatGPT assistant turn has no stable data-turn-id identity");
    }
    const typed = identities as string[];
    if (new Set(typed).size !== typed.length) throw new Error("ChatGPT assistant turn identities are ambiguous");
    const lastId = typed.at(-1);
    return lastId ? { count, lastId, identities: typed } : { count, identities: typed };
  });
  const page = (turns as unknown as Partial<Pick<Locator, "page">>).page?.();
  if (!page) return state;
  const knownTurnIdentities = await readChatGptTurnIdentities(
    page.locator("[data-turn-id-container]"), "data-turn-id-container",
  );
  const known = new Set(knownTurnIdentities);
  if (state.identities?.some(identity => !known.has(identity))) {
    throw new Error("ChatGPT assistant turn has no matching identity container");
  }
  return { ...state, knownTurnIdentities };
}

export async function readChatGptTurnIdentities(
  turns: Pick<Locator, "evaluateAll">,
  attribute = "data-turn-id",
): Promise<string[]> {
  return turns.evaluateAll((elements, name) => {
    const candidates = name === "data-turn-id-container"
      ? elements.filter(element => element.parentElement?.closest("[data-turn-id-container]")
        ?.getAttribute("data-turn-id-container") !== element.getAttribute("data-turn-id-container"))
      : elements;
    const identities = candidates.map(element => element.getAttribute(name));
    if (identities.some(identity => typeof identity !== "string" || identity.trim().length === 0)) {
      throw new Error(`ChatGPT conversation turn has no stable ${name} identity`);
    }
    const typed = identities as string[];
    if (new Set(typed).size !== typed.length) throw new Error("ChatGPT conversation turn identities are ambiguous");
    return typed;
  }, attribute);
}

export function chatGptNewTurnIdentity(
  initial: readonly string[],
  current: readonly string[],
): string | undefined {
  const previous = new Set(initial);
  const added = current.filter(identity => !previous.has(identity));
  if (added.length > 1) throw new Error(`ChatGPT exposed ${added.length} new conversation turns for one submitted message`);
  return added[0];
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
  return turns.page().locator(`[data-turn-id=${JSON.stringify(binding.id)}]`);
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
}): ChatGptSubmissionEvidence | undefined {
  if (state.initialTurnIdentities && state.userIdentities && state.responseIdentities) {
    if (chatGptNewTurnIdentity(state.initialTurnIdentities, state.userIdentities)) return "user_turn";
    if (chatGptNewTurnIdentity(state.initialTurnIdentities, state.responseIdentities)) return "assistant_turn";
    return state.generationRunning ? "generation_running" : undefined;
  }
  if (state.userTurnCount > state.initialUserTurnCount) return "user_turn";
  if (chatGptAssistantTurnChanged(
    { count: state.initialAssistantTurnCount, ...(state.initialAssistantTurnId ? { lastId: state.initialAssistantTurnId } : {}) },
    { count: state.assistantTurnCount, ...(state.assistantTurnId ? { lastId: state.assistantTurnId } : {}) },
  )) return "assistant_turn";
  if (state.generationRunning) return "generation_running";
  return undefined;
}
