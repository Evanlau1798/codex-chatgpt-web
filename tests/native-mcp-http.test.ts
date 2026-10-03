import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { startChatGptMcpHttpServer } from "../src/adapters/chatgpt-web/mcp-http-server";

const key = "private-fixture-control-token-not-a-real-credential";
const makeClient = async (endpoint: string, name: string) => {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  }));
  return client;
};

test("real MCP HTTP clients isolate reused RPC ids and do not head-of-line block native tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-http-"));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  const environment = { cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" as const },
    tools: [{ name: "exec_command", description: "Execute", parameters: {} }] };
  const a = await broker.register(environment, undefined, "http-parent", undefined, true);
  const b = await broker.register(environment, undefined, "http-child", undefined, true);
  const http = await startChatGptMcpHttpServer({ brokerSocketPath: socket, controlToken: key, port: 0 });
  const clients: Client[] = [];
  try {
    const parent = await makeClient(http.endpoint, "parent"); clients.push(parent);
    const child = await makeClient(http.endpoint, "child"); clients.push(child);
    let aReturned = false;
    const held = parent.callTool({ name: "codex_tool_call", arguments: { turn_token: a, wire_name: "exec_command", arguments: { cmd: "owned-a" } } });
    void held.then(() => { aReturned = true; });
    const [first] = await broker.nextToolBatch(a, AbortSignal.timeout(5000));
    const quick = child.callTool({ name: "codex_tool_call", arguments: { turn_token: b, wire_name: "exec_command", arguments: { cmd: "owned-b" } } });
    const [second] = await broker.nextToolBatch(b, AbortSignal.timeout(5000));
    expect(second!.arguments).toEqual({ cmd: "owned-b" });
    broker.completeTool(b, second!.callId, { content: [{ type: "text", text: "CHILD_RESULT" }] });
    expect(JSON.stringify((await quick).content)).toContain("CHILD_RESULT");
    expect(aReturned).toBeFalse();
    broker.completeTool(a, first!.callId, { content: [{ type: "text", text: "PARENT_RESULT" }] });
    expect(JSON.stringify((await held).content)).toContain("PARENT_RESULT");
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    await http.close();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP HTTP refuses unauthenticated, browser-origin and malformed requests before invocation", async () => {
  const http = await startChatGptMcpHttpServer({ brokerSocketPath: defaultBrokerEndpoint(), controlToken: key, port: 0 });
  const send = (headers: Record<string, string>, body = "{}") => fetch(http.endpoint, { method: "POST", headers, body });
  const allowed = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  try {
    expect((await send({ "content-type": "application/json" })).status).toBe(401);
    expect((await send({ ...allowed, origin: "https://attacker.invalid" })).status).toBe(403);
    expect((await send({ ...allowed, host: "attacker.invalid" })).status).toBe(403);
    expect((await send({ ...allowed, "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await send({ ...allowed, "content-type": "text/plain" })).status).toBe(415);
    expect((await send(allowed, "{" )).status).toBe(400);
    expect(http.activeRequests()).toBe(0);
  } finally { await http.close(); }
});
