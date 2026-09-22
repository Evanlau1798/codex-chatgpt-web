import { expect, test } from "bun:test";
import { parseChatCompletion, compileChatCompletion, decodeChatCompletion, chatOutputTokens, boundedChatText, wellFormedText } from "../src/chat-completions/contract";

const request = () => ({ model: "chatgpt-web/high", messages: [{ role: "user", content: "inert fixture" }] });
const tool = { type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } };
const call = { id: "call_fixture", type: "function", function: { name: "old_function", arguments: '{"path":"fixture.txt"}' } };

test("preserves ordered roles and literal Unicode/text parts without creating native context", () => {
  const messages = [
    { role: "system", content: "system fixture" }, { role: "developer", content: "developer fixture" },
    { role: "user", content: [{ type: "text", text: "\n  alpha\r\n" }, { type: "text", text: "\u00a0👩‍💻e\u0301\u0000" }] },
  ];
  const input = parseChatCompletion({ ...request(), messages });
  expect(input.messages.map(m => m.role)).toEqual(["system", "developer", "user"]);
  expect(input.messages[2]!.content).toBe("\n  alpha\r\n\u00a0👩‍💻e\u0301\u0000");
  const compiled = compileChatCompletion(input);
  const records = JSON.parse(compiled.slice(compiled.indexOf('{"messages"')));
  expect(records.messages).toEqual(input.messages);
  expect(records).not.toHaveProperty("turnToken"); expect(records).not.toHaveProperty("cwd");
});

for (const [field, value] of Object.entries({ temperature: 0, top_p: 1, seed: 1, stop: ["x"], n: 2, store: true,
  max_completion_tokens: 100, reasoning_effort: "high", response_format: { type: "json_object" },
  metadata: {}, previous_response_id: "prior", nativeConnector: true, tools: [{ type: "web_search" }],
  stream_options: { include_usage: true }, max_tokens: 0 })) {
  test(`rejects unsupported semantic field ${field}`, () => expect(() => parseChatCompletion({ ...request(), [field]: value })).toThrow());
}
for (const content of [null, [{ type: "image_url", image_url: { url: "data:fixture" } }], "\ud800", "\udc00"]) {
  test(`rejects invalid user content ${JSON.stringify(content)}`, () => expect(() => parseChatCompletion({ ...request(), messages: [{ role: "user", content }] })).toThrow());
}

test("matches tool results by ID and permits history functions absent from current tools", () => {
  const messages = [...request().messages, { role: "assistant", content: null, tool_calls: [call] },
    { role: "tool", tool_call_id: "call_fixture", content: "old result" }];
  expect(parseChatCompletion({ ...request(), messages, tools: [tool] }).messages[2]!.tool_call_id).toBe("call_fixture");
  expect(() => parseChatCompletion({ ...request(), messages: messages.slice(0, -1) })).toThrow();
  expect(() => parseChatCompletion({ ...request(), messages: [...messages, messages[2]] })).toThrow();
  expect(() => parseChatCompletion({ ...request(), messages: [messages[2]] })).toThrow();
  expect(() => parseChatCompletion({ ...request(), messages: [messages[0], messages[1], messages[0]] })).toThrow();
});
test("multiple calls require distinct IDs and all results before continuation", () => {
  const messages = [request().messages[0], { role: "assistant", content: "", tool_calls: [call, { ...call, id: "second" }] },
    { role: "tool", tool_call_id: "second", content: "2" }, { role: "tool", tool_call_id: "call_fixture", content: "1" }];
  expect(parseChatCompletion({ ...request(), messages }).messages).toHaveLength(4);
  expect(() => parseChatCompletion({ ...request(), messages: [messages[0], { ...messages[1], tool_calls: [call, call] }] })).toThrow();
});
for (const parameters of [{ type: "object", properties: { x: { $ref: "https://example.invalid/schema" } } },
  { type: "object", properties: { value: { type: "string", pattern: "^(a+)+$" } } },
  { type: "object", patternProperties: { "^(a+)+$": { type: "string" } } },
  { type: "object", $async: true }, { type: "array" }, { type: "object", invalidKeyword: true }]) {
  test(`rejects unsafe/unsupported schema ${JSON.stringify(parameters)}`, () => expect(() => parseChatCompletion({ ...request(), tools: [{ type: "function", function: { name: "read", parameters } }] })).toThrow());
}
test("strict decoding is not claimed and Ajv does not coerce arguments", () => {
  expect(() => parseChatCompletion({ ...request(), tools: [{ ...tool, function: { ...tool.function, strict: true } }] })).toThrow();
  const input = parseChatCompletion({ ...request(), tools: [tool] });
  expect(() => decodeChatCompletion(input, JSON.stringify({ content: null, tool_calls: [{ name: "read", arguments: { path: 42 } }] }))).toThrow();
});

test("returns validated calls with standard JSON arguments and unique IDs", () => {
  const input = parseChatCompletion({ ...request(), tools: [tool], tool_choice: "required" });
  const result = decodeChatCompletion(input, JSON.stringify({ content: null, tool_calls: [{ name: "read", arguments: { path: "a" } }, { name: "read", arguments: { path: "b" } }] }));
  expect(result.finishReason).toBe("tool_calls");
  expect(result.tool_calls![0]!.function.arguments).toBe('{"path":"a"}');
  expect(result.tool_calls![0]!.id).not.toBe(result.tool_calls![1]!.id);
});
for (const answer of ['```json\n{}\n```', '{}', '{"content":null,"tool_calls":[]}',
  '{"content":"done","tool_calls":[],"extra":1}',
  '{"content":null,"tool_calls":[{"name":"unknown","arguments":{}}]}',
  '{"content":null,"tool_calls":[{"name":"read","arguments":{"path":"a","bad":true}}]}']) {
  test(`rejects invalid completed model envelope ${answer}`, () => expect(() => decodeChatCompletion(parseChatCompletion({ ...request(), tools: [tool] }), answer)).toThrow());
}

test("rejects presentation-escaped function JSON instead of guessing its contents", () => {
  const input = parseChatCompletion({ ...request(), tools: [tool] });
  const rendered = '{"content":null,"tool\\_calls":\\[{"name":"read","arguments":{"path":"safe.txt"}}\\]}';
  expect(() => decodeChatCompletion(input, rendered)).toThrow();
  const literalSlash = JSON.stringify({ content: null, tool_calls: [{ name: "read", arguments: { path: "a\\_b" } }] });
  expect(decodeChatCompletion(input, literalSlash).tool_calls?.[0]?.function.arguments).toBe('{"path":"a\\\\_b"}');
  const renderedLiteralSlash = literalSlash.replace(`a${"\\".repeat(2)}_b`, `a${"\\".repeat(3)}_b`);
  expect(() => decodeChatCompletion(input, renderedLiteralSlash)).toThrow();
  expect(() => decodeChatCompletion(input, rendered.replace("tool\\_calls", "tool\\*calls"))).toThrow();
});
test("required, named and parallel false are enforced after generation", () => {
  const final = JSON.stringify({ content: "done", tool_calls: [] });
  for (const tool_choice of ["required", { type: "function", function: { name: "read" } }]) {
    expect(() => decodeChatCompletion(parseChatCompletion({ ...request(), tools: [tool], tool_choice }), final)).toThrow();
  }
  expect(() => decodeChatCompletion(parseChatCompletion({ ...request(), tools: [tool], parallel_tool_calls: false }), JSON.stringify({ content: null,
    tool_calls: [{ name: "read", arguments: { path: "a" } }, { name: "read", arguments: { path: "b" } }] }))).toThrow();
  expect(decodeChatCompletion(parseChatCompletion({ ...request(), tools: [tool], tool_choice: "none" }), final).content).toBe(final);
});
test("visible-output limit uses tokens and never emits truncated executable calls", () => {
  const value = "你好，世界 👩‍💻\n".repeat(80);
  const result = decodeChatCompletion(parseChatCompletion({ ...request(), max_tokens: 10 }), value);
  expect(result.finishReason).toBe("length"); expect(chatOutputTokens(result.content!)).toBeLessThanOrEqual(10);
  expect(wellFormedText(result.content!)).toBeTrue(); expect(value.startsWith(result.content!)).toBeTrue();
  const functionResult = decodeChatCompletion(parseChatCompletion({ ...request(), tools: [tool], max_tokens: 1 }),
    JSON.stringify({ content: null, tool_calls: [{ name: "read", arguments: { path: "safe.txt" } }] }));
  expect(functionResult.finishReason).toBe("length"); expect(functionResult.tool_calls).toBeUndefined();
  const prefix = boundedChatText(value, 10);
  expect(boundedChatText(value + "more", 10, prefix).startsWith(prefix)).toBeTrue();
});

test("escaped invalid Unicode in generated arguments is rejected after parsing", () => {
  const input = parseChatCompletion({ ...request(), tools: [tool] });
  expect(() => decodeChatCompletion(input, '{"content":null,"tool_calls":[{"name":"read","arguments":{"path":"\\ud800"}}]}')).toThrow();
});

for (const literal of ["1e999", "-1e999", "9007199254740993"]) {
  test(`rejects non-representable numeric arguments before serialization: ${literal}`, () => {
    const numericTool = { type: "function", function: { name: "numeric", parameters: { type: "object" } } };
    const input = parseChatCompletion({ ...request(), tools: [numericTool] });
    expect(() => decodeChatCompletion(input,
      `{"content":null,"tool_calls":[{"name":"numeric","arguments":{"value":${literal}}}]}`)).toThrow();
    expect(() => parseChatCompletion({ ...request(), messages: [
      { role: "assistant", content: null, tool_calls: [{ ...call, function: { name: "numeric", arguments: `{"value":${literal}}` } }] },
      { role: "tool", tool_call_id: call.id, content: "result" },
    ] })).toThrow();
    expect(() => parseChatCompletion({ ...request(), tools: [{ ...numericTool, function: { ...numericTool.function,
      parameters: { type: "object", properties: { value: { type: "number", maximum: JSON.parse(literal) } } } } }] })).toThrow();
  });
}
test("finite fractional and safely representable numeric arguments survive unchanged", () => {
  const input = parseChatCompletion({ ...request(), tools: [{ type: "function", function: { name: "numeric", parameters: { type: "object" } } }] });
  const args = { integer: Number.MAX_SAFE_INTEGER, fraction: 0.125, small: 1e-20 };
  const result = decodeChatCompletion(input, JSON.stringify({ content: null, tool_calls: [{ name: "numeric", arguments: args }] }));
  expect(JSON.parse(result.tool_calls![0]!.function.arguments)).toEqual(args);
});
