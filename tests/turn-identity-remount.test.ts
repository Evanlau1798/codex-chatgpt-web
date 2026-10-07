import { expect, test } from "bun:test";
import { createDocument } from "@mixmark-io/domino";
import { CHATGPT_ASSISTANT_TURN_SELECTOR, CHATGPT_USER_TURN_SELECTOR } from "../src/chatgpt-session";
import {
  bindChatGptAssistantTurn,
  chatGptAssistantTurnChanged,
  chatGptNewTurnIdentity,
  chatGptReboundTurnIdentity,
  chatGptSubmissionEvidence,
  readChatGptAssistantTurnState,
  readChatGptTurnIdentities,
} from "../src/adapters/chatgpt-web/response-turn-boundary";

function surface(keys: string[]) {
  const document = createDocument(keys.map(key => `<section data-turn-key="${key}">
    <div data-user-message-bubble></div><h4 data-conversation-role="assistant"></h4>
  </section>`).join(""));
  const page = { locator: (selector: string): any => ({
    page: () => page,
    evaluateAll: async (callback: Function, argument?: unknown) =>
      callback([...document.querySelectorAll(selector)], argument),
  }) };
  return {
    assistant: () => readChatGptAssistantTurnState(page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR)),
    users: () => readChatGptTurnIdentities(page.locator(CHATGPT_USER_TURN_SELECTOR)),
  };
}

test("restored history before the retained anchor does not interrupt an accepted tool response", async () => {
  const initial = await surface(["visible"]).assistant();
  const expanded = surface(["restored-history", "visible", "submitted"]);
  const current = await expanded.assistant();
  expect(chatGptAssistantTurnChanged(initial, current)).toBeTrue();
  expect(bindChatGptAssistantTurn(initial, current)).toEqual({
    id: "group:assistant:submitted", ordinal: 2, generation: 0,
  });
  expect(chatGptSubmissionEvidence({
    initialUserTurnCount: 1, userTurnCount: 3,
    initialAssistantTurnCount: initial.count, assistantTurnCount: current.count,
    initialTurnIdentities: initial.knownTurnIdentities,
    userIdentities: await expanded.users(), responseIdentities: current.identities,
    generationRunning: true,
  })).toBe("user_turn");
  expect(chatGptReboundTurnIdentity(initial.knownTurnIdentities!, "detached", current.identities!))
    .toBe("group:assistant:submitted");
});

test("history restoration alone is not a new response or submission", async () => {
  const initial = await surface(["visible"]).assistant();
  const current = await surface(["restored-history", "visible"]).assistant();
  expect(chatGptAssistantTurnChanged(initial, current)).toBeFalse();
  expect(bindChatGptAssistantTurn(initial, current)).toBeUndefined();
});

test("two additions after the anchor still reject a duplicated submission", async () => {
  const initial = await surface(["visible"]).assistant();
  const current = await surface(["restored-history", "visible", "submitted", "foreign"]).assistant();
  expect(() => chatGptAssistantTurnChanged(initial, current)).toThrow("2 new conversation turns");
});

test("an absent anchor does not authorize ignoring unknown history", () => {
  expect(() => chatGptNewTurnIdentity(["visible"], ["restored-history", "submitted"]))
    .toThrow("2 new conversation turns");
});

test("retained identity reordering cannot establish a history boundary", () => {
  expect(() => chatGptNewTurnIdentity(["old-1", "old-2"], ["old-2", "old-1", "submitted"]))
    .toThrow("history order changed");
});

test("a retained older anchor remains usable when newer known history is virtualized", () => {
  expect(chatGptNewTurnIdentity(["old-1", "old-2"], ["restored-history", "old-1", "submitted"]))
    .toBe("submitted");
});
