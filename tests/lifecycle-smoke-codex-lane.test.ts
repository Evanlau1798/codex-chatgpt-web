import { expect, test } from "bun:test";
import { childTtlResumePrompt } from "../scripts/lifecycle-smoke/codex-lane";

test("Codex child TTL prompt names the exact existing agent and required tool", () => {
  const prompt = childTtlResumePrompt("grandchild-thread-id");

  expect(prompt).toContain("send_input");
  expect(prompt).toContain("target=grandchild-thread-id");
  expect(prompt).toContain("不要另派");
});
