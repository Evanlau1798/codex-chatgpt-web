import { expect, test } from "bun:test";
import { ChatGptTurnSession, ChatGptTextFeed, ChatGptTraceFeed } from "../src/adapters/chatgpt-web/turn-execution";
import { completeChatGptToolResults } from "../src/adapters/chatgpt-web/tool-result-delivery";
import type { CodexParsedRequest, CodexToolResultMessage } from "../src/types";
import { NativeAgentInputInbox } from "../src/adapters/chatgpt-web/native-agent-input";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import { startChatGptMcpHttpServer } from "../src/adapters/chatgpt-web/mcp-http-server";

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
  // Keep additive data in the primary text result, not a separate optional block.
  expect((delivered[0] as { content: Array<{ text?: string }> }).content[0]?.text).toContain("Worker applied left.mjs");
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

test.each(["agent", "steering", "checkpoint"] as const)("%s input survives a timed-out native wait slice through real broker and MCP SDK", async kind => {
  const root = mkdtempSync(join(tmpdir(), "agent-input-wire-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const key = "agent-input-wire-private-fixture-token";
  const token = await broker.register({ cwd: root, roots: [root], writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" }, tools: [{ name: "collaboration__wait_agent", description: "wait", parameters: {} }],
  }, undefined, "agent-input-wire", undefined, true);
  const http = await startChatGptMcpHttpServer({ brokerSocketPath: broker.socketPath, controlToken: key, port: 0 });
  const client = new Client({ name: "agent-input-wire", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(http.endpoint), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
    const response = client.callTool({ name: "codex_tool_call", arguments: { turn_token: token,
      wire_name: "collaboration__wait_agent", arguments: { timeout_ms: 60000 } } });
    const [request] = await broker.nextToolBatch(token, AbortSignal.timeout(5000));
    const session = new ChatGptTurnSession({ mode: "read-only", browser: new Promise<string>(() => {}),
      trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {} });
    session.observeCanonicalRequest(parsed([]));
    session.setOutstanding([request!]);
    if (kind === "agent") session.observeCanonicalRequest(parsed([completion]));
    if (kind === "steering") session.queueSteering("USER_GUIDANCE_AFTER_WAIT", true, "owned-guidance");
    await completeChatGptToolResults(session, broker, token, [{ role: "toolResult", toolCallId: request!.callId,
      toolName: request!.wireName, isError: false,
      content: JSON.stringify({ message: "Wait timed out.", timed_out: true }), timestamp: 0 }],
      kind === "checkpoint" ? { recoveryCheckpointInstruction: "OWNED_RECOVERY_CHECKPOINT" } : {});
    const initial = await response;
    const pending = initial.structuredContent as { operation_status?: string; next_query?: string };
    expect(pending.operation_status).toBe("pending");
    expect(pending.next_query).toBeString();
    const actual = await client.callTool({ name: "codex_tool_inventory", arguments: { turn_token: token,
      query: pending.next_query! } });
    expect(JSON.stringify(actual.content)).toContain(kind === "agent" ? "Worker applied left.mjs"
      : kind === "steering" ? "USER_GUIDANCE_AFTER_WAIT" : "OWNED_RECOVERY_CHECKPOINT");
    if (kind === "agent") expect(JSON.stringify(actual.content)).toContain("agent_message");
    const ready = actual.structuredContent as { operation_status?: string; result?: { structuredContent?: { timed_out?: boolean } } };
    expect(ready.operation_status).toBe("ready");
    expect(ready.result?.structuredContent?.timed_out).toBe(true);
    expect(actual.isError).not.toBeTrue();
    expect(session.nativeAgentInputs.peek()).toEqual([]);
  } finally {
    await client.close(); await http.close(); await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
