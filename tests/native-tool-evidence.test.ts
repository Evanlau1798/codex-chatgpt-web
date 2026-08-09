import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { defaultBrokerEndpoint } from "../src/config";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import type { CodexParsedRequest } from "../src/types";

const evidenceContract = "Describe failed local actions using only observable tool evidence. If no native result was returned, state only that the action did not execute; never infer or name an unreported cause.";

function parsedRequest(): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    context: { messages: [{ role: "user", content: "Run the requested check", timestamp: 1 }] },
    options: { reasoning: "high" },
  };
}

function brokerEndpoint(name: string): string {
  return process.platform === "win32"
    ? defaultBrokerEndpoint(join(tmpdir(), name), "win32")
    : join(tmpdir(), `${name}.sock`);
}

async function waitForLog(read: () => string, text: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (read().includes(text)) return;
    await Bun.sleep(10);
  }
  throw new Error(`MCP diagnostic log did not contain: ${text}`);
}

test("tool-capable prompts require evidence before assigning a failure cause", () => {
  const token = "turn_12345678901234567890123456789012";
  const compiled = compileChatGptWebPrompt(
    parsedRequest(),
    { localToolsEnabled: true, solAvailable: true, proAvailable: true },
    token,
  );
  expect(compiled.text).toContain(evidenceContract);

  const compact = parsedRequest();
  compact._compactionRequest = true;
  expect(compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: true, solAvailable: true, proAvailable: true },
    token,
  ).text).not.toContain(evidenceContract);
});

test("MCP diagnostics distinguish claims from native invocation results without logging inputs", async () => {
  const socketPath = brokerEndpoint(`cgw-native-evidence-${process.pid}-${Date.now()}`);
  const broker = TurnBroker.forSocket(socketPath);
  const environment: ChatGptTurnEnvironment = {
    cwd: process.cwd(),
    roots: [process.cwd()],
    writableRoots: [process.cwd()],
    sandboxPolicy: { type: "dangerFullAccess" },
    tools: [{ name: "exec", description: "Outer native gateway", parameters: {}, freeform: true }],
  };
  const token = await broker.register(environment, 60_000);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--broker-socket", socketPath],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: "native-tool-evidence-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const invalid = await client.callTool({
      name: "codex_tool_inventory",
      arguments: { turn_token: "turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    });
    expect(invalid.isError).toBe(true);
    await waitForLog(() => stderr, "tool=codex_tool_inventory phase=claim status=failed errorType=Error");

    await client.callTool({
      name: "codex_tool_inventory",
      arguments: { turn_token: token, query: "exec", include_schema: false },
    });
    await waitForLog(() => stderr, "tool=codex_tool_inventory phase=claim status=completed");

    const commandMarker = "must-not-appear-in-diagnostics";
    const execution = client.callTool({
      name: "codex_exec",
      arguments: { turn_token: token, cmd: commandMarker },
    });
    const [request] = await broker.nextToolBatch(token);
    broker.completeTool(token, request!.callId, {
      content: [{ type: "text", text: "outer tool rejected the operation" }],
      isError: true,
    });
    expect((await execution).isError).toBe(true);
    await waitForLog(() => stderr, "phase=invoke status=completed isError=true");

    expect(stderr).toContain("tool=codex_exec phase=claim status=completed");
    expect(stderr).toContain("tool=exec phase=invoke status=started");
    expect(stderr).not.toContain(commandMarker);
    expect(stderr).not.toContain(token);
  } finally {
    await client.close().catch(() => {});
    broker.revoke(token);
    await broker.close();
  }
}, 30_000);
