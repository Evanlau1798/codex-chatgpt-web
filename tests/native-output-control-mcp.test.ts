import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RemoteTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";

test("Native2 accepts bound output without per-turn inventory discovery", async () => {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "native2-output-"));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  const client = new Client({ name: "output-control-contract-test", version: "1.0.0" });
  try {
    const token = await broker.register({
      cwd: root, roots: [root], writableRoots: [],
      sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [],
    }, undefined, "direct-output-test", undefined, true);
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--broker-socket", socket],
      cwd: resolve(import.meta.dir, ".."), stderr: "pipe",
    }));
    // The trusted prompt supplies this control; no inventory discovery is needed.
    const accepted = await client.callTool({
      name: "codex_tool_call",
      arguments: { turn_token: token, wire_name: "codex.control.output", arguments: { kind: "final", text: "Review complete." } },
    });
    expect(accepted.isError).not.toBe(true);
    expect(accepted.structuredContent).toEqual({ accepted: true, sequence: 1, duplicate: false });
    // Acceptance queues output; consumption remains a separate operation.
    expect(await new RemoteTurnBroker(socket).nextOutput(token, 0))
      .toEqual({ sequence: 1, kind: "final", text: "Review complete." });
  } finally {
    await client.close().catch(() => {});
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
