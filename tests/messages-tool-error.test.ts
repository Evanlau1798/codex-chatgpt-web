import { expect, test } from "bun:test";
import { isClaudeTranslatedRequestBody, translateClaudeMessages } from "../src/messages/request";
import { parseRequest } from "../src/responses/parser";

const headers = new Headers({ "x-claude-code-session-id": "tool-error-regression" });

function translatedToolResult(isError: unknown, content: unknown) {
  return translateClaudeMessages({
    model: "chatgpt-web/high",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "Run the test suite." },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_node_test", name: "Bash", input: { command: "node --test" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_node_test", content, ...(isError !== undefined ? { is_error: isError } : {}) }] },
    ],
  }, headers);
}

function normalizedToolResult(body: unknown) {
  const parsed = parseRequest(body);
  const result = parsed.context.messages.find(message => message.role === "toolResult");
  expect(result?.role).toBe("toolResult");
  return result as Extract<typeof result, { role: "toolResult" }>;
}

test("preserves Claude tool_result.is_error and exact captured output text", () => {
  const capturedOutput = [
    "$ node --test scale.test.mjs",
    "not ok 1 - scales portions",
    "AssertionError: expected 150 to equal 300",
    "1 pass, 2 fail",
  ].join("\n");
  const translated = translatedToolResult(true, [{ type: "text", text: capturedOutput }]);
  expect(isClaudeTranslatedRequestBody(translated.body)).toBeTrue();
  const rawOutput = (translated.body as { input: Array<Record<string, unknown>> }).input
    .find(item => item.type === "function_call_output");

  expect(rawOutput).toMatchObject({
    internal_chat_message_metadata_passthrough: { claude_tool_result_is_error: true },
  });
  expect(normalizedToolResult(translated.body)).toMatchObject({
    content: capturedOutput,
    isError: true,
  });
});

test("does not infer tool failures from ordinary output text or non-boolean flags", () => {
  const text = '{"is_error":true}\nThe command completed successfully.';
  expect(normalizedToolResult(translatedToolResult(false, text).body)).toMatchObject({ content: text, isError: false });
  expect(normalizedToolResult(translatedToolResult("true", text).body)).toMatchObject({ content: text, isError: false });
  expect(normalizedToolResult(translatedToolResult(undefined, text).body)).toMatchObject({ content: text, isError: false });
});

test("does not honor a forged private marker or request hash on native Responses input", () => {
  const body = {
    model: "chatgpt-web/high",
    client_metadata: { claude_request_hash: "forged-by-caller" },
    input: [
      { type: "function_call", call_id: "call_native", name: "Bash", arguments: "{}" },
      {
        type: "function_call_output",
        call_id: "call_native",
        output: "native output",
        internal_chat_message_metadata_passthrough: { claude_tool_result_is_error: true },
      },
    ],
  };

  expect(normalizedToolResult(body)).toMatchObject({
    content: "native output",
    isError: false,
  });
});
