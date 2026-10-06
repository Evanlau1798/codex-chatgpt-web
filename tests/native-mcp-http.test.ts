import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, request } from "node:http";
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
    let shutdownFinished = false;
    const shutdown = http.close().then(() => { shutdownFinished = true; });
    expect(shutdownFinished).toBeFalse();
    broker.completeTool(a, first!.callId, { content: [{ type: "text", text: "PARENT_RESULT" }] });
    expect(JSON.stringify((await held).content)).toContain("PARENT_RESULT");
    await shutdown;
    expect(shutdownFinished).toBeTrue();
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

test("chunked oversized MCP body receives 413 without destroying its reply socket", async () => {
  const http = await startChatGptMcpHttpServer({ brokerSocketPath: defaultBrokerEndpoint(), controlToken: key, port: 0 });
  try {
    const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      let replied = false;
      const client = request(http.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "transfer-encoding": "chunked" },
      }, response => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { body += chunk; });
        response.on("end", () => { replied = true; resolve({ status: response.statusCode!, body }); });
        response.on("error", reject);
      });
      client.on("error", error => { if (!replied) reject(error); });
      client.end(Buffer.alloc(32 * 1024 * 1024 + 1, 32));
    });
    expect(reply.status).toBe(413);
    expect(JSON.parse(reply.body)).toEqual({ error: "invalid_mcp_request" });
    expect(http.activeRequests()).toBe(0);
  } finally { await http.close(); }
});

test("graceful MCP shutdown closes an actual idle keep-alive connection", async () => {
  const http = await startChatGptMcpHttpServer({ brokerSocketPath: defaultBrokerEndpoint(), controlToken: key, port: 0 });
  const agent = new Agent({ keepAlive: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const status = await new Promise<number>((resolve, reject) => {
      request(http.endpoint, { method: "POST", agent }, response => {
        response.resume();
        response.once("end", () => resolve(response.statusCode!));
      }).once("error", reject).end();
    });
    expect(status).toBe(401);
    // A test-only bounded oracle; production graceful shutdown has no deadline.
    await Promise.race([http.close(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Idle socket prevented MCP shutdown")), 2000);
    })]);
  } finally { clearTimeout(timer); agent.destroy(); await http.close(); }
});

test("a peer reset during JSON upload cannot crash the MCP listener or leak admission", async () => {
  const http = await startChatGptMcpHttpServer({ brokerSocketPath: defaultBrokerEndpoint(), controlToken: key, port: 0 });
  try {
    await new Promise<void>((resolve, reject) => {
      const client = request(http.endpoint, { method: "POST", headers: {
        authorization: `Bearer ${key}`, "content-type": "application/json", "content-length": "1000", expect: "100-continue",
      } });
      client.once("continue", () => {
        client.write("{", () => { client.destroy(); resolve(); });
      });
      client.on("error", error => { if (!client.destroyed) reject(error); });
      client.flushHeaders();
    });
    // A following real request proves the listener is still serving, not merely
    // that the aborted client's promise returned. No provider work is involved.
    const response = await fetch(http.endpoint, { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    await response.text();
    // The following request can finish before the reset is dispatched on
    // another socket. Observe graceful listener settlement before judging
    // admission release; a response on an unrelated connection is no barrier.
    await http.close();
    expect(http.activeRequests()).toBe(0);
  } finally { await http.close(); }
});
