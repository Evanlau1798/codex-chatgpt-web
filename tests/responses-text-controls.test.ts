import { expect, test } from "bun:test";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { createChatGptStructuredOutputValidator } from "../src/adapters/chatgpt-web/output-validation";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { parseRequest } from "../src/responses/parser";

const capabilities = { localToolsEnabled: false, solAvailable: true, proAvailable: true };
const parse = (text: unknown) => parseRequest({
  model: CHATGPT_WEB_MODEL_ID,
  stream: true,
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Return it." }] }],
  text,
});

test("verbosity and JSON-schema controls survive parser-to-prompt transport", () => {
  const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
  const parsed = parse({ verbosity: "high", format: { type: "json_schema", name: "result", strict: true, schema } });
  expect(parsed.options.verbosity).toBe("high");
  expect(parsed.options.outputFormat).toEqual({ type: "json_schema", name: "result", strict: true, schema });
  const compiled = compileChatGptWebPrompt(parsed, capabilities);
  expect(compiled.text).toContain("Codex requested high response verbosity.");
  expect(compiled.text).toContain('strict JSON-schema final answer named "result"');
  expect(compiled.text).toContain(JSON.stringify(schema));
});

test("strict JSON validation accepts only the exact full schema-conforming answer", () => {
  const validate = createChatGptStructuredOutputValidator({
    type: "json_schema",
    name: "payload",
    strict: true,
    schema: {
      type: "object",
      properties: { ok: { type: "boolean" }, count: { type: "integer", minimum: 0 } },
      required: ["ok", "count"],
      additionalProperties: false,
    },
  })!;
  expect(() => validate('{"ok":true,"count":2}')).not.toThrow();
  for (const invalid of [
    'prefix {"ok":true,"count":2}',
    '```json\n{"ok":true,"count":2}\n```',
    '{"ok":"yes","count":2}',
    '{"ok":true,"count":2,"extra":1}',
  ]) expect(() => validate(invalid)).toThrow(ChatGptWebAdapterError);
});

test("non-strict JSON-schema output remains best-effort", () => {
  const parsed = parse({ format: { type: "json_schema", name: "item", strict: false, schema: { type: "string" } } });
  expect(createChatGptStructuredOutputValidator(parsed.options.outputFormat)).toBeUndefined();
});

test("invalid strict schema fails before browser execution", () => {
  expect(() => createChatGptStructuredOutputValidator({
    type: "json_schema", name: "bad", strict: true, schema: { type: "not-a-json-schema-type" },
  })).toThrow(ChatGptWebAdapterError);
});
