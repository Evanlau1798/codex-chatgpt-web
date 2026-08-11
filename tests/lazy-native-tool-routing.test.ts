import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import type { CodexTool } from "../src/types";

const result = (value: unknown): BrokerToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});

async function clientFor(socketPath: string): Promise<Client> {
  const client = new Client({ name: "lazy-native-tool-routing-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--broker-socket", socketPath],
    cwd: process.cwd(),
    stderr: "pipe",
  }));
  return client;
}

test("loads a deferred stateful tool into the same Native2 turn without an exec fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-lazy-tool-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const toolSearch: CodexTool = {
    name: "tool_search",
    description: "Load deferred tools",
    parameters: { type: "object", properties: { query: { type: "string" } } },
    toolSearch: true,
  };
  const nodeRepl: CodexTool = {
    name: "js",
    namespace: "mcp__node_repl",
    description: "Run JavaScript in the persistent Node kernel",
    parameters: { type: "object", properties: { code: { type: "string" } } },
    loadedFromToolSearch: true,
  };
  const environment = {
    cwd: process.cwd(),
    roots: [process.cwd()],
    writableRoots: [],
    sandboxPolicy: { type: "readOnly" as const, networkAccess: false },
    tools: [toolSearch],
  };
  const token = await broker.register(environment, 60_000, "lazy-tool-test");
  const client = await clientFor(socketPath);

  try {
    const missing = await client.callTool({
      name: "codex_tool_call",
      arguments: { turn_token: token, wire_name: "mcp__node_repl__js", arguments: { code: "1 + 1" } },
    });
    expect(missing.isError).toBe(true);
    expect((missing.content as Array<{ text: string }>)[0]?.text).toContain("not available in this turn");

    const inventory = await client.callTool({
      name: "codex_tool_inventory",
      arguments: { turn_token: token, query: "tool_search", include_schema: false },
    });
    expect(inventory.structuredContent).toMatchObject({
      total: 1,
      tools: [{ wire_name: "tool_search", kind: "tool_search" }],
    });

    const search = client.callTool({
      name: "codex_tool_call",
      arguments: {
        turn_token: token,
        wire_name: "tool_search",
        arguments: { query: "persistent Node computer control", limit: 10 },
      },
    });
    const [searchRequest] = await broker.nextToolBatch(token);
    expect(searchRequest).toMatchObject({
      wireName: "tool_search",
      freeform: false,
      arguments: { query: "persistent Node computer control", limit: 10 },
    });
    broker.completeTool(token, searchRequest!.callId, result({ tools: [nodeRepl] }));
    expect((await search).isError).not.toBe(true);

    broker.updateEnvironment(token, { ...environment, tools: [toolSearch, nodeRepl] });
    const loaded = await client.callTool({
      name: "codex_tool_inventory",
      arguments: { turn_token: token, query: "node_repl", include_schema: false },
    });
    expect(loaded.structuredContent).toMatchObject({
      total: 1,
      tools: [{ wire_name: "mcp__node_repl__js", kind: "function" }],
    });

    const invoke = client.callTool({
      name: "codex_tool_call",
      arguments: {
        turn_token: token,
        wire_name: "mcp__node_repl__js",
        arguments: { code: "1 + 1" },
      },
    });
    const [invokeRequest] = await broker.nextToolBatch(token);
    expect(invokeRequest).toMatchObject({
      wireName: "mcp__node_repl__js",
      freeform: false,
      arguments: { code: "1 + 1" },
    });
    broker.completeTool(token, invokeRequest!.callId, result({ value: 2 }));
    expect((await invoke).structuredContent).toEqual({ value: 2 });
  } finally {
    await client.close().catch(() => {});
    broker.revoke(token);
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("routes codex_exec through Claude Code Bash when Codex command tools are absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-claude-bash-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const environment = {
    cwd: process.cwd(),
    roots: [process.cwd()],
    writableRoots: [],
    sandboxPolicy: { type: "readOnly" as const, networkAccess: false },
    tools: [{
      name: "Bash",
      description: "Execute a command through Claude Code",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    }],
  };
  const token = await broker.register(environment, 60_000, "claude-bash-test");
  const client = await clientFor(socketPath);

  try {
    const execution = client.callTool({
      name: "codex_exec",
      arguments: { turn_token: token, cmd: "pwd", workdir: process.cwd() },
    });
    const [request] = await broker.nextToolBatch(token);
    expect(request).toMatchObject({
      wireName: "Bash",
      freeform: false,
    });
    const command = (request?.arguments as Record<string, unknown>).command;
    expect(command).toBeString();
    expect(command as string).toContain("cd --");
    expect(command as string).toEndWith(" && pwd");
    broker.completeTool(token, request!.callId, result({ stdout: process.cwd(), exitCode: 0 }));
    expect((await execution).structuredContent).toEqual({ stdout: process.cwd(), exitCode: 0 });
  } finally {
    await client.close().catch(() => {});
    broker.revoke(token);
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
