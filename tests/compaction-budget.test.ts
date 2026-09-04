import { expect, test } from "bun:test";
import { buildCompactV1Output, COMPACT_PROMPT, extractCompactUserMessages } from "../src/responses/compaction";
import { estimateTokens } from "../src/lib/token-estimate";

const user = (text: string, id = "latest") => ({
  type: "message", role: "user", id,
  content: [{ type: "input_text", text }],
});

test("checkpoint instructions distinguish current work from superseded history", () => {
  expect(COMPACT_PROMPT).toContain("cancelled or superseded");
  expect(COMPACT_PROMPT).toContain("Replace prior summaries");
  expect(COMPACT_PROMPT).toContain("language preference");
  expect(COMPACT_PROMPT).toContain("re-read when evidence is stale");
});

test("many short messages charge their envelopes against the retained token budget", () => {
  const input = Array.from({ length: 30_000 }, (_, i) => user("OK", `user-${i}`));
  const output = buildCompactV1Output(input, "Current task checkpoint.");
  expect(estimateTokens(JSON.stringify(output.slice(0, -1)))).toBeLessThanOrEqual(20_000);
  expect(output.at(-2)?.id).toBe("user-29999");
});

test("latest instruction is never tail-truncated even beyond the optional history budget", () => {
  const latest = user(`DO_NOT_DEPLOY\n${"reference ".repeat(30_000)}\nInspect only.`);
  const output = buildCompactV1Output([user("Earlier task", "old"), latest], "Inspect only.");
  expect(output.find(item => item.id === "latest")).toEqual(latest);
  expect(output.some(item => item.id === "old")).toBe(false);
});

test("contextual wrappers cannot crowd out the latest actual instruction", () => {
  const latest = user("Cancel deployment. Inspect only.");
  const wrapper = user(`<environment_context>${"context ".repeat(40_000)}</environment_context>`, "environment");
  const output = buildCompactV1Output([latest, wrapper], "Deployment was cancelled.");
  expect(output.find(item => item.id === "latest")).toEqual(latest);
  expect(output.some(item => item.id === "environment")).toBe(false);
});

test("fixed history and summary reach a stable replacement across 100 compactions", () => {
  let input: Record<string, unknown>[] = [user("Continue the current task.")];
  let baseline = "";
  for (let cycle = 0; cycle < 100; cycle += 1) {
    input = buildCompactV1Output(extractCompactUserMessages(input), "One current checkpoint.");
    const serialized = JSON.stringify(input);
    if (cycle === 0) baseline = serialized;
    expect(serialized).toBe(baseline);
  }
});
