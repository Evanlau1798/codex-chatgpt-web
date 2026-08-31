import { expect, test } from "bun:test";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { parseRequest } from "../src/responses/parser";

const capabilities = { localToolsEnabled: false, solAvailable: true, proAvailable: true };

function request() {
  return parseRequest({
    model: CHATGPT_WEB_MODEL_ID,
    stream: true,
    instructions: "Preserve the native conversation semantics.",
    input: [
      {
        type: "agent_message",
        author: "parent",
        recipient: "child",
        content: [{ type: "input_text", text: "Inspect the failing request and report evidence." }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue from the agent report." }],
      },
    ],
  });
}

function inlineMessages(text: string): Array<Record<string, unknown>> {
  const match = text.match(/<codex_context_json>\n([^\n]+)\n<\/codex_context_json>/);
  if (!match?.[1]) throw new Error("inline Codex context JSON missing");
  return (JSON.parse(match[1]) as { messages: Array<Record<string, unknown>> }).messages;
}

test("parser preserves plaintext agent-message routing metadata", () => {
  const parsed = request();
  expect(parsed.context.messages[0]).toEqual({
    role: "agentMessage",
    author: "parent",
    recipient: "child",
    content: "Inspect the failing request and report evidence.",
    timestamp: expect.any(Number),
  });
});

test("inline Web context emits a distinct agent_message envelope", () => {
  const compiled = compileChatGptWebPrompt(request(), capabilities);
  const messages = inlineMessages(compiled.text);
  expect(messages[0]).toEqual({
    role: "agent_message",
    author: "parent",
    recipient: "child",
    content: "Inspect the failing request and report evidence.",
  });
  expect(messages[1]).toEqual({
    role: "user",
    content: "Continue from the agent report.",
  });
  expect(compiled.text).toContain("agent_message messages are inter-agent inputs");
  expect(compiled.text).toContain("Exclude agent_message inputs");
});

test("multipart Web context emits the same agent_message envelope", () => {
  const compiled = compileChatGptWebPrompt(
    request(),
    capabilities,
    undefined,
    { experimentalMultipartParts: 2 },
  );
  const records = compiled.multipart!.parts.flatMap(part => (
    (JSON.parse(part) as { records: Array<Record<string, unknown>> }).records
  ));
  const messages = records
    .filter(record => record.kind === "message")
    .map(record => record.message as Record<string, unknown>);
  expect(messages[0]).toEqual({
    role: "agent_message",
    author: "parent",
    recipient: "child",
    content: "Inspect the failing request and report evidence.",
  });
});

test("ordinary user messages do not gain agent metadata", () => {
  const messages = inlineMessages(compileChatGptWebPrompt(request(), capabilities).text);
  expect(messages[1]).not.toHaveProperty("author");
  expect(messages[1]).not.toHaveProperty("recipient");
});

test("agent messages do not invent missing routing identity or fallback content", () => {
  const parsed = parseRequest({
    model: CHATGPT_WEB_MODEL_ID,
    stream: true,
    input: [{ type: "agent_message", content: "" }],
  });
  expect(parsed.context.messages[0]).toMatchObject({ role: "agentMessage", content: "" });
  expect(parsed.context.messages[0]).not.toHaveProperty("author");
  expect(parsed.context.messages[0]).not.toHaveProperty("recipient");
  const messages = inlineMessages(compileChatGptWebPrompt(parsed, capabilities).text);
  expect(messages[0]).toEqual({ role: "agent_message", content: "" });
});
