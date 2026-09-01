import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";

async function execute(program: string, names: string[], calls: Array<{ name: string; input: unknown }>) {
  const tools = Object.fromEntries(names.map(name => [name, async (input: unknown) => {
    calls.push({ name, input });
    return { output: name };
  }]));
  const content: Array<{ type: "text"; text: string }> = [];
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => (...values: unknown[]) => Promise<void>;
  await new AsyncFunction("tools", "ALL_TOOLS", "text", "image", "audio", "generatedImage", program)(
    tools,
    names.map(name => ({ name, description: `${name} description` })),
    (value: unknown) => content.push({ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }),
    () => {}, () => {}, () => {},
  );
  return content;
}

test("MCP gateway discovers and invokes nested tools while rejecting unsafe waits and recursion", async () => {
  const root = join(tmpdir(), `cgw-native-gateway-${process.pid}-${Date.now()}`);
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const token = await broker.register({
    cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" },
    tools: [{ name: "exec", description: "Run nested tools", parameters: {}, freeform: true }],
  }, 60_000);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--broker-socket", socketPath],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "native-gateway-test", version: "1.0.0" });
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  try {
    await client.connect(transport);
    const inventory = call("codex_tool_inventory", {
      turn_token: token, query: "web__run", include_schema: true,
    });
    const [inventoryRequest] = await broker.nextToolBatch(token);
    const inventoryContent = await execute(inventoryRequest!.input!, ["exec", "web__run"], []);
    broker.completeTool(token, inventoryRequest!.callId, { content: inventoryContent });
    expect((await inventory).structuredContent).toMatchObject({
      total: 1, tools: [{ wire_name: "web__run", kind: "gateway" }],
    });

    const nestedCalls: Array<{ name: string; input: unknown }> = [];
    const nested = call("codex_tool_call", {
      turn_token: token, wire_name: "web__run", arguments: { q: "Codex" },
    });
    const [nestedRequest] = await broker.nextToolBatch(token);
    const nestedContent = await execute(nestedRequest!.input!, ["web__run"], nestedCalls);
    broker.completeTool(token, nestedRequest!.callId, { content: nestedContent });
    expect(nestedCalls).toEqual([{ name: "web__run", input: { q: "Codex" } }]);
    expect((await nested).isError).not.toBeTrue();

    const invalidWait = await call("codex_tool_call", {
      turn_token: token, wire_name: "multi_agent_v2__wait_agent",
      arguments: { targets: [], timeout_ms: 180_000 },
    });
    expect(invalidWait.isError).toBeTrue();
    expect(JSON.stringify(invalidWait.content)).toContain("timeout_ms=10000");

    const recursive = call("codex_tool_call", {
      turn_token: token, wire_name: "exec", input: "await tools.exec('nested');",
    });
    const [recursiveRequest] = await broker.nextToolBatch(token);
    await expect(execute(recursiveRequest!.input!, ["exec"], [])).rejects.toThrow("Nested raw exec");
    broker.completeTool(token, recursiveRequest!.callId, {
      content: [{ type: "text", text: "Nested raw exec is unavailable" }], isError: true,
    } satisfies BrokerToolResult);
    expect((await recursive).isError).toBeTrue();
  } finally {
    await client.close().catch(() => {});
    broker.revoke(token);
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
