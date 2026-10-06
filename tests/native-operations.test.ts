import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { startChatGptMcpHttpServer } from "../src/adapters/chatgpt-web/mcp-http-server";

const key = "private-operation-fixture-control-token";
const connect = async (endpoint: string) => {
  const client = new Client({ name: "operation-fixture", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return client;
};
const environment = (root: string) => ({ cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" as const },
  tools: [{ name: "exec_command", description: "Execute", parameters: {} }] });

test("real MCP reconnect retains one native invocation and independently verified file mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-op-"));
  const socket = defaultBrokerEndpoint(root), broker = TurnBroker.forSocket(socket);
  const token = await broker.register(environment(root), undefined, "operation", undefined, true);
  const other = await broker.register(environment(root), undefined, "foreign", undefined, true);
  const http = await startChatGptMcpHttpServer({ brokerSocketPath: socket, controlToken: key, port: 0, resumableOperations: true });
  const clients: Client[] = [];
  let executor: Promise<number> | undefined;
  try {
    const first = await connect(http.endpoint); clients.push(first);
    const input = { turn_token: token, operation_key: "same-intended-command", wire_name: "exec_command", arguments: { cmd: "fixture-increment" } };
    const start = first.callTool({ name: "codex_operation_start", arguments: input });
    const [request] = await broker.nextToolBatch(token, AbortSignal.timeout(5000));
    expect(request!.arguments).toEqual(input.arguments);
    const counter = join(root, "counter.txt");
    const child = Bun.spawn([process.execPath, "-e", "setTimeout(()=>{const fs=require('node:fs'),p=process.argv[1]; const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;fs.writeFileSync(p,String(n+1)); console.log('REAL_NATIVE_RESULT')},2200)", counter], { stdout: "pipe", stderr: "pipe" });
    executor = (async () => {
      const stdout = await new Response(child.stdout).text();
      const code = await child.exited;
      broker.completeTool(token, request!.callId, { content: [{ type: "text", text: stdout }], isError: code !== 0 });
      return code;
    })();
    const pending = (await start).structuredContent as any;
    expect(pending.operation_status).toBe("pending");
    expect(pending.native_invocation_complete).toBeFalse();
    expect(broker.beginCompletionFence(token)).toBeUndefined();
    await first.close();
    const second = await connect(http.endpoint); clients.push(second);
    const recovered = (await second.callTool({ name: "codex_operation_start", arguments: input })).structuredContent as any;
    expect(recovered.operation_id).toBe(pending.operation_id);
    const ready = await second.callTool({ name: "codex_operation_result", arguments: { turn_token: token, operation_id: pending.operation_id, wait_ms: 30000 } });
    expect((ready.structuredContent as any).operation_status).toBe("ready");
    expect(JSON.stringify(ready.content)).toContain("REAL_NATIVE_RESULT");
    expect(await executor).toBe(0);
    expect(readFileSync(counter, "utf8")).toBe("1");
    await expect(broker.nextToolBatch(token, AbortSignal.timeout(30))).rejects.toThrow("tool wait aborted");
    expect(broker.beginCompletionFence(token)).toBeNumber();
    expect((await second.callTool({ name: "codex_operation_result", arguments: { turn_token: other, operation_id: pending.operation_id } })).isError).toBeTrue();
    expect((await second.callTool({ name: "codex_operation_start", arguments: { ...input, arguments: { cmd: "different-work" } } })).isError).toBeTrue();
    expect(JSON.stringify((await second.callTool({ name: "codex_operation_start", arguments: input })).content)).toContain("REAL_NATIVE_RESULT");
    expect(readFileSync(counter, "utf8")).toBe("1");
  } finally {
    await executor;
    await Promise.allSettled(clients.map(client => client.close()));
    await http.close(); await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test("cancelled response wait does not retire work; owner retirement does", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-op-abort-"));
  const socket = defaultBrokerEndpoint(root), broker = TurnBroker.forSocket(socket);
  const token = await broker.register(environment(root), undefined, "operation-abort", undefined, true);
  try {
    const claim = await callTurnBroker<{ bindingId: string }>(socket, { method: "claim", token });
    const started = await callTurnBroker<any>(socket, { method: "start_operation", bindingId: claim.bindingId,
      operationKey: "once", wireName: "exec_command", freeform: false, arguments: { cmd: "owned" } });
    const [request] = await broker.nextToolBatch(token);
    const controller = new AbortController();
    const wait = callTurnBroker(socket, { method: "read_operation", token, operationId: started.operation_id, waitMs: 30000 }, 35000, controller.signal);
    const outcome = wait.then(() => false, () => true);
    controller.abort();
    expect(await outcome).toBeTrue();
    broker.completeTool(token, request!.callId, { content: [{ type: "text", text: "NATIVE_ERROR" }], isError: true });
    const done = await callTurnBroker<any>(socket, { method: "read_operation", token, operationId: started.operation_id });
    expect(done.result.isError).toBeTrue();
    broker.revoke(token, new Error("explicit fixture owner cancellation"));
    await expect(callTurnBroker(socket, { method: "read_operation", token, operationId: started.operation_id })).rejects.toThrow();
  } finally { await broker.close(); rmSync(root, { recursive: true, force: true }); }
});
