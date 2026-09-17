import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import {
  NATIVE2_CONTRACT_REVISION,
  NATIVE2_PUBLIC_CONTRACT_HASH,
  ZERO_RISK_CONTRACT_REVISION,
  ZERO_RISK_PUBLIC_CONTRACT_HASH,
  consumeConnectorContractProbeEvidence,
  discardConnectorContractProbeEvidence,
} from "../src/adapters/chatgpt-web/connector-contract";
import { defaultBrokerEndpoint } from "../src/config";

const { RuntimeSupervisor } = require("../launcher/electron/runtime-supervisor.cjs");
const root = resolve(import.meta.dir, "..");

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

for (const mode of ["manual", "automatic"] as const) {
  test(`actual launcher ${mode} MCP invocation exposes the matching protocol`, async () => {
    const home = mkdtempSync(join(tmpdir(), "cgw-mcp-"));
    try {
      expect(Buffer.byteLength(defaultBrokerEndpoint(home, "linux"))).toBeLessThanOrEqual(103);
      const socketPath = defaultBrokerEndpoint(home);
      const broker = TurnBroker.forSocket(socketPath);
      let serialized = "";
      const supervisor = new RuntimeSupervisor({
        app: { isPackaged: false }, sourceRoot: root, coreHome: root,
        browserDescriptorPath: resolve(root, "test-descriptor.json"), logger: {},
      });
      supervisor.runTunnelCommand = async (_config: unknown, args: string[]) => {
        serialized = args[args.indexOf("--mcp-command") + 1]!;
        return { code: 0 };
      };
      const previousBun = process.env.CODEX_CHATGPT_WEB_BUN;
      try {
        process.env.CODEX_CHATGPT_WEB_BUN = process.execPath;
        await supervisor.runTunnelConnectCommand({
          browserInteractionMode: mode, brokerSocketPath: socketPath, tunnel: {},
        });
      } finally {
        if (previousBun === undefined) delete process.env.CODEX_CHATGPT_WEB_BUN;
        else process.env.CODEX_CHATGPT_WEB_BUN = previousBun;
      }
      const quoted = serialized.match(/"(?:\\.|[^"\\])*"/g)!;
      expect(quoted.join(" ")).toBe(serialized);
      const [command, ...args] = quoted.map(value => JSON.parse(value) as string);
      const client = new Client({ name: "launcher-contract-regression", version: "1.0.0" });
      const transport = new StdioClientTransport({
        command: command!, args, cwd: root, stderr: "pipe",
      });
      try {
        await client.connect(transport);
        const listed = await client.listTools();
        const tools = listed.tools.map(tool => tool.name);
        expect(tools).not.toContain("codex_contract_probe");
        expect(tools.includes("codex_turn_start")).toBe(mode === "manual");
        expect(tools.includes("codex_turn_complete")).toBe(mode === "manual");
        const contract = mode === "manual" ? "safe" : "native";
        const publicConnectorAbi = listed.tools.map(tool => ({
            name: tool.name,
            title: tool.title ?? null,
            description: tool.description ?? null,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema ?? null,
            annotations: tool.annotations ?? null,
          }));
        expect(createHash("sha256").update(canonicalJson(publicConnectorAbi)).digest("hex"))
          .toBe(mode === "manual" ? ZERO_RISK_PUBLIC_CONTRACT_HASH : NATIVE2_PUBLIC_CONTRACT_HASH);
        expect(args).toEqual([
          "run", resolve(root, "src/cli.ts"), "mcp", "--contract", contract, "--broker-socket", socketPath,
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
          const unstartedProbeNonce = "22222222222222222222222222222222";
          discardConnectorContractProbeEvidence(unstartedProbeNonce);
          const unstartedProbe = await client.callTool({ name: "codex_tool_inventory", arguments: {
            request_id: requestId,
            query: `__codex_contract_probe__:${ZERO_RISK_CONTRACT_REVISION}:${unstartedProbeNonce}`,
            include_schema: false,
          } });
          expect(unstartedProbe.isError).toBe(true);
          expect(consumeConnectorContractProbeEvidence(unstartedProbeNonce, ZERO_RISK_CONTRACT_REVISION)).toBeFalse();
          expect((await client.callTool({ name: "codex_turn_start", arguments: { request_id: requestId } }))
            .structuredContent).toMatchObject({ started: true });
          await broker.waitForSafeStart(requestId);
          const probeNonce = "11111111111111111111111111111111";
          expect((await client.callTool({ name: "codex_tool_inventory", arguments: {
            request_id: requestId,
            query: `__codex_contract_probe__:${ZERO_RISK_CONTRACT_REVISION}:${probeNonce}`,
            include_schema: false,
          } })).structuredContent).toEqual({ tools: [], total: 0, next_offset: null });
          expect(consumeConnectorContractProbeEvidence(probeNonce, ZERO_RISK_CONTRACT_REVISION)).toBeTrue();
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
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}
