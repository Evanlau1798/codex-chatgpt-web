import { expect, test } from "bun:test";
import { childTtlResumePrompt } from "../scripts/lifecycle-smoke/codex-lane";
import { hasLocalFileEvidence } from "../scripts/lifecycle-smoke/skill-contract";

test("Codex child TTL prompt names the exact existing agent and required tool", () => {
  const prompt = childTtlResumePrompt("grandchild-thread-id");

  expect(prompt).toContain("send_input");
  expect(prompt).toContain("target=grandchild-thread-id");
  expect(prompt).toContain("不要另派");
});

test("Codex local evidence accepts conventional L-prefixed line references", () => {
  const target = "G:\\repo\\tests\\target.test.ts";
  expect(hasLocalFileEvidence([{
    method: "item/completed",
    params: {
      turnId: "turn",
      item: { type: "commandExecution", command: `Get-Content '${target}'`, status: "completed" },
    },
  }], "turn", target, "replacement boundary 在 L38，持久性覆蓋在 L51–77。")).toBeTrue();
});
