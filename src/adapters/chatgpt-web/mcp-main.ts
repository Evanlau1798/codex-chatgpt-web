import { defaultBrokerEndpoint, loadConfig, resolveBrokerEndpoint } from "../../config";
import { runChatGptMcpServer, type ChatGptMcpContract } from "./mcp-server";
import { startChatGptMcpHttpServer } from "./mcp-http-server";

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1]?.trim();
  if (!value) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

export async function runChatGptMcpMain(args: string[]): Promise<void> {
  const remaining = [...args];
  const resumableOperations = remaining.includes("--resumable-operations");
  if (resumableOperations) remaining.splice(remaining.indexOf("--resumable-operations"), 1);
  const brokerSocketPath = resolveBrokerEndpoint(option(remaining, "--broker-socket", defaultBrokerEndpoint()));
  const requestedContract = option(remaining, "--contract", "native");
  const transport = option(remaining, "--transport", "stdio");
  const explicitPort = remaining.includes("--port");
  const portText = option(remaining, "--port", "17842");
  if (transport !== "stdio" && transport !== "http") throw new Error("--transport must be stdio or http");
  if (transport === "stdio" && explicitPort) throw new Error("--port requires --transport http");
  if (requestedContract !== "native" && requestedContract !== "safe") {
    throw new Error(`--contract must be native or safe, received ${requestedContract}`);
  }
  if (remaining.length > 0) throw new Error(`Unknown MCP arguments: ${remaining.join(" ")}`);
  if (transport === "http") {
    if (!/^\d+$/.test(portText)) throw new Error("--port must be an integer");
    const server = await startChatGptMcpHttpServer({ brokerSocketPath, contract: requestedContract,
      controlToken: loadConfig().controlToken, port: Number(portText), resumableOperations });
    process.stdout.write(`Codex Native MCP HTTP listening at ${server.endpoint}\n`);
    return;
  }
  await runChatGptMcpServer({
    brokerSocketPath,
    contract: requestedContract as ChatGptMcpContract,
    resumableOperations,
  });
}
