import { expect, spyOn, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as z from "zod/v4";
import { observeMcpToolCalls } from "../src/adapters/chatgpt-web/mcp-observation";

test("Native final observations separate handler time from transport write without exposing payload", async () => {
  const events: Array<Record<string, unknown>> = [];
  let now = 100;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const message = { jsonrpc: "2.0" as const, id: "private-request-id", method: "tools/call",
    params: { name: "codex_tool_call", arguments: { turn_token: "private-token",
      wire_name: "codex.control.output", arguments: { kind: "final", text: "private-answer" } } } };
  const reply = { jsonrpc: "2.0" as const, id: message.id, result: {
    content: [{ type: "text", text: "private-answer" }], structuredContent: { accepted: true, sequence: 1 } } };
  let sent: unknown;
  const transport: Transport = { start: async () => {}, close: async () => {},
    send: async value => { sent = value; now += 7; } };
  try {
    observeMcpToolCalls(transport, new Set(["codex_tool_call"]), event => events.push(event));
    transport.onmessage?.(message);
    now += 20;
    await transport.send(reply);
    expect(sent).toBe(reply);
    expect(events[0]).toMatchObject({ event: "call_received", output_kind: "final" });
    expect(events[1]).toMatchObject({ event: "reply_sent", output_kind: "final",
      handler_elapsed_ms: 20, send_elapsed_ms: 7, elapsed_ms: 27 });
    for (const secret of [message.id, "private-token", "private-answer"]) expect(JSON.stringify(events)).not.toContain(secret);
  } finally { clock.mockRestore(); }
});

test.each([null, "private-invalid-value", { wire_name: "private-other-control", arguments: { kind: "final" } },
  { wire_name: "codex.control.output", arguments: null },
  { wire_name: "codex.control.output", arguments: { kind: "private-invalid-kind" } },
])("unvalidated payloads cannot leak into output timing labels", async args => {
  const events: Array<Record<string, unknown>> = [];
  const transport: Transport = { start: async () => {}, close: async () => {}, send: async () => {} };
  observeMcpToolCalls(transport, new Set(["codex_tool_call"]), event => events.push(event));
  transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "codex_tool_call", arguments: args } });
  await transport.send({ jsonrpc: "2.0", id: 1, result: {} });
  expect(events).toHaveLength(2);
  expect(events.every(event => !("output_kind" in event))).toBeTrue();
  expect(JSON.stringify(events)).not.toContain("private");
});

test("MCP observations separate pre-handler validation and returned tool errors without recording content", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const events: Array<Record<string, unknown>> = [];
  const secret = "fixture-private-path-token-and-command";
  let invoked = 0;
  const server = new McpServer({ name: "observation-test", version: "1" });
  server.registerTool("codex_exec", { inputSchema: { cmd: z.string() } }, async () => {
    invoked += 1;
    return { isError: invoked === 1, content: [{ type: "text", text: secret }] };
  });
  observeMcpToolCalls(serverTransport, new Set(["codex_exec"]), event => events.push(event));
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1" });
  try {
    await client.connect(clientTransport);
    const invalid = await client.callTool({ name: "codex_exec", arguments: { private_key: secret } });
    expect(invalid.isError).toBeTrue();
    expect(invoked).toBe(0);
    const refused = await client.callTool({ name: "codex_exec", arguments: { cmd: secret } });
    const accepted = await client.callTool({ name: "codex_exec", arguments: { cmd: secret } });
    expect(refused.isError).toBeTrue();
    expect(accepted.isError).toBeFalse();
    expect(refused.content).toEqual(accepted.content);
    expect(invoked).toBe(2);
    expect(events.map(event => event.event)).toEqual(Array(3).fill(["call_received", "reply_sent"]).flat());
    expect(events.filter(event => event.event === "reply_sent").map(event => event.is_error)).toEqual([true, true, false]);
    expect(events.map(event => event.call)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain("private_key");
    expect(JSON.stringify(events)).not.toContain("content");
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP observation failures, arbitrary IDs and unknown names never alter transport behavior", async () => {
  const events: Array<Record<string, unknown>> = [];
  const secret = "private-id-and-tool-name";
  const originalError = new Error("private transport failure");
  let received = 0;
  let closed = false;
  const transport: Transport = {
    start: async () => {}, close: async () => {},
    onmessage: () => { received += 1; }, onclose: () => { closed = true; },
    send: async () => { throw originalError; },
  };
  observeMcpToolCalls(transport, new Set(["codex_exec"]), event => {
    events.push(event);
    throw new Error("sink unavailable");
  });
  transport.onmessage?.({ jsonrpc: "2.0", id: secret, method: "tools/call", params: { name: secret } });
  expect(received).toBe(1);
  await expect(transport.send({ jsonrpc: "2.0", id: secret, result: {} })).rejects.toBe(originalError);
  expect(events.at(-1)).toMatchObject({ event: "reply_send_failed", tool: "unknown" });
  expect(JSON.stringify(events)).not.toContain(secret);
  expect(JSON.stringify(events)).not.toContain(originalError.message);
  const duplicate = { jsonrpc: "2.0" as const, id: 7, method: "tools/call", params: { name: "codex_exec" } };
  transport.onmessage?.(duplicate);
  transport.onmessage?.(duplicate);
  expect(events.at(-1)).toMatchObject({ event: "uncorrelated_call", reason: "duplicate_id" });
  const count = events.length;
  await expect(transport.send({ jsonrpc: "2.0", id: 7, result: {} })).rejects.toBe(originalError);
  expect(events).toHaveLength(count);
  transport.onclose?.();
  expect(closed).toBeTrue();
});
