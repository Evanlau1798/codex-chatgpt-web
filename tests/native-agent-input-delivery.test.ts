import { expect, test } from "bun:test";
import { ChatGptTurnSession, ChatGptTextFeed, ChatGptTraceFeed } from "../src/adapters/chatgpt-web/turn-execution";
import { completeChatGptToolResults } from "../src/adapters/chatgpt-web/tool-result-delivery";
import type { CodexParsedRequest, CodexToolResultMessage } from "../src/types";
import { NativeAgentInputInbox } from "../src/adapters/chatgpt-web/native-agent-input";

// Shape taken from the captured real Codex V2 parent request: completion is
// separate agent_message input, while wait_agent itself says "Wait completed".
const completion = { type: "agent_message", id: "native-result-left", author: "/root/left", recipient: "/root",
  content: [{ type: "input_text", text: "Worker applied left.mjs and its native test exited 0. Parent integration remains." }] };
const parsed = (input: unknown[]) => ({ _canonicalContextComplete: true, context: { messages: [] },
  _rawBody: { input, client_metadata: { "x-codex-turn-metadata": JSON.stringify({ agent_name: "/root" }) } },
}) as unknown as CodexParsedRequest;

test("retained parent receives new native agent input with wait result, without relabeling it human guidance", async () => {
  const session = new ChatGptTurnSession({ mode: "read-only", browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {} });
  session.observeCanonicalRequest(parsed([]));
  session.setOutstanding([{ callId: "wait-1", wireName: "collaboration__wait_agent", freeform: false, arguments: {} }], []);
  session.observeCanonicalRequest(parsed([completion]));
  const delivered: unknown[] = [];
  await completeChatGptToolResults(session, { completeTool: async (_token, _id, result) => { delivered.push(result); } }, "owned-token",
    [{ role: "toolResult", toolCallId: "wait-1", toolName: "collaboration__wait_agent", isError: false, content: "Wait completed", timestamp: 0 }]);
  expect(JSON.stringify(delivered)).toContain("Worker applied left.mjs");
  expect(JSON.stringify(delivered)).toContain('agent_message');
  expect(JSON.stringify(delivered)).not.toContain("Additional user guidance");
  session.observeCanonicalRequest(parsed([completion]));
  session.setOutstanding([{ callId: "wait-2", wireName: "collaboration__wait_agent", freeform: false, arguments: {} }], []);
  await completeChatGptToolResults(session, { completeTool: async (_token, _id, result) => { delivered.push(result); } }, "owned-token",
    [{ role: "toolResult", toolCallId: "wait-2", toolName: "collaboration__wait_agent", isError: false, content: "Wait completed", timestamp: 0 }]);
  expect(JSON.stringify(delivered[1])).not.toContain("Worker applied left.mjs");
});

test("initial history is seeded, foreign recipients ignored and subsequent inputs are delivered once", () => {
  const inbox = new NativeAgentInputInbox();
  inbox.observe(parsed([completion]));
  expect(inbox.peek()).toEqual([]);
  inbox.observe(parsed([completion, { ...completion, id: "foreign", recipient: "/another/root" }]));
  expect(inbox.peek()).toEqual([]);
  inbox.observe(parsed([completion, { ...completion, id: "right", author: "/root/right" }]));
  expect(inbox.peek()).toHaveLength(1);
  inbox.acknowledge(1);
  inbox.observe(parsed([completion, { ...completion, id: "right", author: "/root/right" }]));
  expect(inbox.peek()).toEqual([]);
});

test("changed identities, opaque content and capacity excess fail before delivery", () => {
  const inbox = new NativeAgentInputInbox();
  inbox.observe(parsed([]));
  inbox.observe(parsed([completion]));
  expect(() => inbox.observe(parsed([{ ...completion, content: "changed" }]))).toThrow("changed its content");
  expect(() => inbox.observe(parsed([{ ...completion, id: "opaque", content: [{ type: "encrypted", encrypted_content: "opaque" }] }]))).toThrow("readable text");
  expect(() => inbox.observe(parsed([{ ...completion, id: "large", content: "x".repeat(1048577) }]))).toThrow("capacity");
  expect(inbox.peek()).toHaveLength(1);
});

test("a failed broker acknowledgement cannot consume pending agent data", async () => {
  const session = new ChatGptTurnSession({ mode: "read-only", browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {} });
  session.observeCanonicalRequest(parsed([]));
  session.setOutstanding([{ callId: "wait", wireName: "collaboration__wait_agent", freeform: false, arguments: {} }], []);
  session.observeCanonicalRequest(parsed([completion]));
  const results: CodexToolResultMessage[] = [{ role: "toolResult", toolCallId: "wait", toolName: "collaboration__wait_agent", isError: false, content: "Wait completed", timestamp: 0 }];
  await expect(completeChatGptToolResults(session, { completeTool: async () => { throw new Error("fixture disconnected"); } }, "token", results)).rejects.toThrow("disconnected");
  expect(session.nativeAgentInputs.peek()).toHaveLength(1);
  const delivered: unknown[] = [];
  await completeChatGptToolResults(session, { completeTool: async (_token, _id, result) => { delivered.push(result); } }, "token", results);
  expect(JSON.stringify(delivered)).toContain("Worker applied left.mjs");
  expect(session.nativeAgentInputs.peek()).toEqual([]);
});
