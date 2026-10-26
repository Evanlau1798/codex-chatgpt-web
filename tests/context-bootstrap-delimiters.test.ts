import { expect, test } from "bun:test";
import { prepareChatGptWebContext } from "../src/adapters/chatgpt-web/context-bootstrap";
import { withoutRetiredTurnHandles } from "../src/adapters/chatgpt-web/prompt-multipart";
import type { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

test("archive selection budgets escaped Markdown delimiters without losing any context", async () => {
  const envelope = { version: 3, system: ["Preserve all literal Markdown."], messages: [
    { role: "user", content: "```ts\n" + "`code` ".repeat(1000) + "\n```" },
    { role: "user", content: "Review this code exactly." },
  ] };
  const before = "Transport instructions.\n", after = "\nTerminal contract.";
  const text = before + "<codex_context_json>\n" + withoutRetiredTurnHandles(JSON.stringify(envelope))
    + "\n</codex_context_json>" + after;
  let archive = "";
  const broker = {
    registerContext: async (value: string) => { archive = value; return "context_" + "a".repeat(32); },
    revokeContext: () => {},
  } as unknown as TurnBroker;
  const prepared = await prepareChatGptWebContext(broker, {
    text, images: [], turnToken: "turn_" + "b".repeat(32), bootstrapLimits: { chars: 12_000, tokens: 12_000 },
  }, true, 60_000, "delimiter-budget");
  expect(prepared.transport).toBe("native2-archive");
  expect(prepared.text.length).toBeLessThanOrEqual(12_000);
  expect(prepared.text.startsWith(before)).toBeTrue();
  expect(prepared.text.endsWith(after)).toBeTrue();
  const json = prepared.text.split("<codex_context_json>\n")[1]!.split("\n</codex_context_json>")[0]!;
  expect(json).not.toContain("`");
  const restored = JSON.parse(json);
  for (const line of archive.split("\n").slice(1, -1)) {
    const record = JSON.parse(line);
    expect(record.kind).toBe("message");
    restored.messages.splice(record.index,0,record.value);
  }
  expect(restored).toEqual(envelope);
  expect(prepared.modelInputText).toBe(text);
  prepared.release();
});
