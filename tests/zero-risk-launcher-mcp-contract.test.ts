import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";

const { RuntimeSupervisor } = require("../launcher/electron/runtime-supervisor.cjs");
const root = resolve(import.meta.dir, "..");

for (const mode of ["manual", "automatic"] as const) {
  test(`actual launcher ${mode} MCP invocation exposes the matching protocol`, async () => {
    const socketPath = defaultBrokerEndpoint(resolve(root, "tmp", `mcp-contract-${mode}-${crypto.randomUUID()}`));
    const broker = TurnBroker.forSocket(socketPath);
    let invocation!: { executable: string; args: string[]; cwd: string };
    let serialized = "";
    const supervisor = Object.assign(Object.create(RuntimeSupervisor.prototype), {
      runtimeCommand(args: string[]) {
        invocation = { executable: process.execPath, args: [resolve(root, "src/cli.ts"), ...args], cwd: root };
        return invocation;
      },
      async runTunnelCommand(_config: unknown, args: string[]) {
        serialized = args[args.indexOf("--mcp-command") + 1]!;
        return { code: 0 };
      },
    });
    await supervisor.runTunnelConnectCommand({
      browserInteractionMode: mode, brokerSocketPath: socketPath, tunnel: {},
    });
    const client = new Client({ name: "launcher-contract-regression", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: invocation.executable, args: invocation.args, cwd: root, stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools.map(tool => tool.name);
      expect(tools.includes("codex_turn_start")).toBe(mode === "manual");
      expect(tools.includes("codex_turn_complete")).toBe(mode === "manual");
      const contract = mode === "manual" ? "safe" : "native";
      expect(invocation.args).toEqual([
        resolve(root, "src/cli.ts"), "mcp", "--contract", contract, "--broker-socket", socketPath,
      ]);
      expect(serialized).toContain('"--contract"');
      expect(serialized).toContain(`"${contract}"`);
      if (mode === "manual") {
        const nonce = "surface_nonce_launcher_contract";
        const requestId = await broker.registerSafe({
          cwd: root, roots: [root], writableRoots: [root],
          sandboxPolicy: { type: "dangerFullAccess" }, tools: [],
        }, nonce, 5_000, "safe-launcher-contract");
        broker.confirmSafeTurnSent(requestId, nonce);
        expect((await client.callTool({ name: "codex_turn_start", arguments: { request_id: requestId } }))
          .structuredContent).toMatchObject({ started: true });
        await broker.waitForSafeStart(requestId);
        expect((await client.callTool({ name: "codex_turn_complete", arguments: {
          request_id: requestId, final_answer: "Launcher contract verified",
        } })).structuredContent).toMatchObject({ completed: true });
        expect(await broker.waitForSafeCompletion(requestId)).toBe("Launcher contract verified");
      }
    } finally {
      await client.close();
      await transport.close();
      await broker.close();
    }
  });
}
