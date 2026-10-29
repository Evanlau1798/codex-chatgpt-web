// 2026-09-25 (2933410): grouped turns coexist with the earlier article layout.
// tests/browser-turn-binding.test.ts covers both; dates do not establish retirement.
export const CHATGPT_TURN_VARIANTS = {
  article: '[data-testid^="conversation-turn-"]:not([data-turn-key] *)',
  grouped: '[data-turn-key]',
} as const;

// The grouped footer is shared with user messages. Response extraction additionally requires
// this control to FOLLOW the last assistant answer, excluding the user's earlier footer.
export const CHATGPT_COMPLETION_ACTION_SELECTOR = 'button[data-testid="copy-turn-action-button"], [data-turn-key] .turn-action-controls button';
export const CHATGPT_ASSISTANT_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="assistant"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"]):not([data-turn-key] *)',
  '[data-turn-key]:has([data-conversation-role="assistant"], [data-chatgpt-agent-turn-start])',
].join(", ");
export const CHATGPT_USER_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="user"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"][data-message-author-role="user"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"]):not([data-turn-key] *)',
  '[data-turn-key]:has([data-user-message-bubble], [data-conversation-role="assistant"], [data-chatgpt-agent-turn-start])',
].join(", ");

/** The new renderer groups both roles under the user's stable turn key. */
export function chatGptTurnContainerSelector(identity: string): string {
  const prefix = "group:assistant:";
  return identity.startsWith(prefix)
    ? `[data-turn-key=${JSON.stringify(identity.slice(prefix.length))}]`
    : `[data-turn-id=${JSON.stringify(identity)}]`;
}

export function chatGptAssistantTurnSelector(identity: string): string {
  const container = chatGptTurnContainerSelector(identity);
  return identity.startsWith("group:assistant:")
    ? `${container}:has([data-conversation-role="assistant"], [data-chatgpt-agent-turn-start])`
    : container;
}
