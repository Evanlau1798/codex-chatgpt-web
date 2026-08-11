import { expect, test } from "bun:test";
import {
  chatGptAssistantTurnChanged,
  chatGptSubmissionEvidence,
} from "../src/adapters/chatgpt-web/response-turn-boundary";

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
