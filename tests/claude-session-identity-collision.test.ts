import { expect, test } from "bun:test";
import { claudeAgentTurnId, claudeSessionThreadId } from "../src/claude-session-identity";

test.each([claudeSessionThreadId, claudeAgentTurnId])("Claude identity normalization cannot alias distinct owners", normalize => {
  expect(normalize("left/right")).not.toBe(normalize("left_right"));
  expect(normalize("x".repeat(80) + "A")).not.toBe(normalize("x".repeat(80) + "B"));
  expect(normalize("left/right")).toBe(normalize("left/right"));
  expect(normalize("ordinary-UUID_123")).toBe("claude_ordinary-UUID_123");
  const escaped = normalize("left/right").slice("claude_".length);
  expect(normalize(escaped)).not.toBe(normalize("left/right"));
  expect(normalize("")).not.toBe(normalize("root"));
  expect(normalize("")).not.toBe(normalize("ephemeral"));
});
