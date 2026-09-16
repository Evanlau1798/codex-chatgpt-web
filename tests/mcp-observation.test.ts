import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as z from "zod/v4";
import { observeMcpToolCalls } from "../src/adapters/chatgpt-web/mcp-observation";

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
