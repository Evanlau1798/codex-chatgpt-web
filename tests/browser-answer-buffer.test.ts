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

test("buffered validation candidates are not classified as client-visible final text", () => {
  const answers = new ChatGptAnswerBuffer();
  answers.append("candidate waiting for completion evidence");

  expect(answers.value()).not.toBe("");
  expect(answers.takeDeliverable(false)).toBe("");
  expect(answers.deliveredChars()).toBe(0);

  expect(answers.takeDeliverable(true)).toBe("candidate waiting for completion evidence");
  expect(answers.deliveredChars()).toBe("candidate waiting for completion evidence".length);
});

test("same-surface error recovery replaces an uncommitted stale candidate", () => {
  const answers = new ChatGptAnswerBuffer();
  answers.append("stale incomplete final");
  answers.retryAfterError(true);
  answers.append("complete recovered final");

  expect(answers.value()).toBe("complete recovered final");
  expect(answers.takeDeliverable(true)).toBe("complete recovered final");
});
