import type { Locator } from "playwright-core";

export interface ChatGptAssistantTurnState {
  count: number;
  lastId?: string;
}

export type ChatGptSubmissionEvidence = "user_turn" | "assistant_turn" | "generation_running";

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
