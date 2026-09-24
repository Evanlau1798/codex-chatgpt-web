import { expect, test } from "bun:test";
import { CHATGPT_BIGGER_CONTEXT_PARTS, formatChatGptWebMultipartCommit, formatChatGptWebMultipartStage,
  partitionMultipartContext, type MultipartContextRecord } from "../src/adapters/chatgpt-web/prompt-multipart";
import { CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER } from "../src/chatgpt-web-models";

const transaction = `ctx_${"a".repeat(32)}`;
test("Bigger Context uses six total parts but retains the three-times context budget", () => {
  expect(CHATGPT_BIGGER_CONTEXT_PARTS).toBe(6);
  expect(CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER).toBe(3);
});
test("partition preserves every ordered record across five inert stages and one final send", () => {
  const records: MultipartContextRecord[] = Array.from({ length: 12 }, (_, i) => ({
    kind: "message", message_index: i, message: { role: i % 2 ? "assistant" : "user", content: `literal ${i} 🧪` },
  }));
  const parts = partitionMultipartContext(records, 6, Array.from({ length: 6 }, () => ({ tokens: 1000, chars: 10000 })));
  expect(parts).toHaveLength(6);
  expect(parts.flatMap(part => JSON.parse(part).records)).toEqual(records);
  const stages = parts.slice(0, -1).map((part, i) => formatChatGptWebMultipartStage(part, transaction, i + 1, 6));
  expect(stages).toHaveLength(5);
  expect(stages[4]!.acknowledgement).toContain(" 5/6 ");
  const final = formatChatGptWebMultipartCommit({ parts, commit: "execute once" }, transaction);
  expect(final).toContain("acknowledged_parts: 5/6");
  expect(final).toContain(parts[5]!);
  expect(final.endsWith("execute once")).toBeTrue();
});
test("retired three-part helper payloads are rejected before send", () => {
  expect(() => formatChatGptWebMultipartCommit({ parts: ["{}", "{}", "{}"], commit: "never" }, transaction)).toThrow();
});
