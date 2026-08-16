import type { Locator } from "playwright-core";

export interface ChatGptAssistantTurnState {
  count: number;
  lastId?: string;
}

export interface ChatGptAssistantTurnBinding {
  id?: string;
  ordinal: number;
  generation: number;
}

export type ChatGptSubmissionEvidence = "user_turn" | "assistant_turn" | "generation_running";

export async function activateChatGptSendControl(
  sendButton: Pick<Locator, "press">,
): Promise<void> {
  await sendButton.press("Enter");
}

export async function readChatGptAssistantTurnState(turns: Locator): Promise<ChatGptAssistantTurnState> {
  const count = await turns.count();
  if (count === 0) return { count };
  const lastId = await turns.last().getAttribute("data-testid").catch(() => null);
  return lastId ? { count, lastId } : { count };
}

export function chatGptAssistantTurnChanged(
  initial: ChatGptAssistantTurnState,
  current: ChatGptAssistantTurnState,
): boolean {
  return current.count > initial.count
    || Boolean(initial.lastId && current.lastId && current.lastId !== initial.lastId);
}

export function bindChatGptAssistantTurn(
  initial: ChatGptAssistantTurnState,
  current: ChatGptAssistantTurnState,
): ChatGptAssistantTurnBinding | undefined {
  if (!chatGptAssistantTurnChanged(initial, current) || current.count < 1) return undefined;
  return {
    ...(current.lastId ? { id: current.lastId } : {}),
    ordinal: current.count - 1,
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
  if (current.count < 1 || !chatGptAssistantTurnChanged(initial, current)) return undefined;
  if (binding.id && current.lastId === binding.id) {
    return { ...binding, ordinal: current.count - 1 };
  }
  if (!current.lastId || current.lastId === initial.lastId) return undefined;
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
  return binding.id
    ? turns.page().getByTestId(binding.id)
    : turns.nth(binding.ordinal);
}

export function chatGptSubmissionEvidence(state: {
  initialUserTurnCount: number;
  userTurnCount: number;
  initialAssistantTurnCount: number;
  assistantTurnCount: number;
  initialAssistantTurnId?: string;
  assistantTurnId?: string;
  generationRunning: boolean;
}): ChatGptSubmissionEvidence | undefined {
  if (state.userTurnCount > state.initialUserTurnCount) return "user_turn";
  if (chatGptAssistantTurnChanged(
    { count: state.initialAssistantTurnCount, ...(state.initialAssistantTurnId ? { lastId: state.initialAssistantTurnId } : {}) },
    { count: state.assistantTurnCount, ...(state.assistantTurnId ? { lastId: state.assistantTurnId } : {}) },
  )) return "assistant_turn";
  if (state.generationRunning) return "generation_running";
  return undefined;
}
