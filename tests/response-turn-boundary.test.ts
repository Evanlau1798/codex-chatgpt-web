import { expect, test } from "bun:test";
import {
  activateChatGptSendControl,
  bindChatGptAssistantTurn,
  chatGptAssistantTurnChanged,
  chatGptSubmissionEvidence,
  reconcileChatGptAssistantTurnBinding,
} from "../src/adapters/chatgpt-web/response-turn-boundary";

test("send control uses semantic keyboard activation", async () => {
  const activations: string[] = [];
  await activateChatGptSendControl({
    press: async key => { activations.push(key); },
  });
  expect(activations).toEqual(["Enter"]);
});

test("assistant identity detects a virtualized retained response without count growth", () => {
  expect(chatGptAssistantTurnChanged(
    { count: 3, lastId: "conversation-turn-7" },
    { count: 3, lastId: "conversation-turn-9" },
  )).toBeTrue();
});

test("assistant identity does not bind an unchanged historical response", () => {
  expect(chatGptAssistantTurnChanged(
    { count: 3, lastId: "conversation-turn-7" },
    { count: 3, lastId: "conversation-turn-7" },
  )).toBeFalse();
  expect(chatGptAssistantTurnChanged({ count: 3 }, { count: 3 })).toBeFalse();
});

test("assistant count growth remains conclusive submission evidence", () => {
  expect(chatGptAssistantTurnChanged(
    { count: 2, lastId: "conversation-turn-5" },
    { count: 3, lastId: "conversation-turn-7" },
  )).toBeTrue();
  expect(chatGptSubmissionEvidence({
    initialUserTurnCount: 1,
    userTurnCount: 1,
    initialAssistantTurnCount: 2,
    assistantTurnCount: 3,
    initialAssistantTurnId: "conversation-turn-5",
    assistantTurnId: "conversation-turn-7",
    generationRunning: false,
  })).toBe("assistant_turn");
});

test("assistant identity change is conclusive submission evidence when count stays fixed", () => {
  expect(chatGptSubmissionEvidence({
    initialUserTurnCount: 1,
    userTurnCount: 1,
    initialAssistantTurnCount: 3,
    assistantTurnCount: 3,
    initialAssistantTurnId: "conversation-turn-7",
    assistantTurnId: "conversation-turn-9",
    generationRunning: false,
  })).toBe("assistant_turn");
});

test("binds the submitted response to its public assistant turn identity", () => {
  expect(bindChatGptAssistantTurn(
    { count: 3, lastId: "conversation-turn-7" },
    { count: 4, lastId: "conversation-turn-9" },
  )).toEqual({ id: "conversation-turn-9", ordinal: 3, generation: 0 });
});

test("keeps an attached response binding when historical turns are virtualized", () => {
  const binding = { id: "conversation-turn-9", ordinal: 3, generation: 0 };
  expect(reconcileChatGptAssistantTurnBinding(
    { count: 3, lastId: "conversation-turn-7" },
    { count: 2, lastId: "conversation-turn-9" },
    binding,
    true,
  )).toEqual(binding);
});

test("rebinds a detached response only to a new post-submission assistant identity", () => {
  expect(reconcileChatGptAssistantTurnBinding(
    { count: 3, lastId: "conversation-turn-7" },
    { count: 3, lastId: "conversation-turn-11" },
    { id: "conversation-turn-9", ordinal: 3, generation: 0 },
    false,
  )).toEqual({ id: "conversation-turn-11", ordinal: 2, generation: 1 });

  expect(reconcileChatGptAssistantTurnBinding(
    { count: 3, lastId: "conversation-turn-7" },
    { count: 3, lastId: "conversation-turn-7" },
    { id: "conversation-turn-9", ordinal: 3, generation: 0 },
    false,
  )).toBeUndefined();
});
