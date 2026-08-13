import { expect, test } from "bun:test";
import { ChatGptAnswerBuffer } from "../src/adapters/chatgpt-web/browser-answer-buffer";

test("answer validation retries replace the rejected candidate", () => {
  const answers = new ChatGptAnswerBuffer();
  answers.append("malformed checkpoint");
  expect(answers.takeDeliverable(false)).toBe("");
  answers.retryReplacement();
  answers.append("CODEX_COMPACTION_HANDOFF\nRecovered handoff.");

  expect(answers.takeDeliverable(true)).toBe(
    "CODEX_COMPACTION_HANDOFF\nRecovered handoff.",
  );
  expect(answers.value()).toBe(
    "CODEX_COMPACTION_HANDOFF\nRecovered handoff.",
  );
});

test("browser error retries preserve the valid partial response", () => {
  const answers = new ChatGptAnswerBuffer();
  answers.append("Completed tool results. ");
  expect(answers.takeDeliverable(true)).toBe("Completed tool results. ");
  answers.continueAfterError();
  answers.append("Final answer.");

  expect(answers.takeDeliverable(true)).toBe("Final answer.");
  expect(answers.value()).toBe("Completed tool results. Final answer.");
});
