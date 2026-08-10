import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareChatGptWebContext } from "../src/adapters/chatgpt-web/context-bootstrap";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";

test("beta prompt transport fetches the full Codex context through one short read-only MCP call", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-context-bootstrap-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const fullText = `full harness\n${"x".repeat(120_000)}\nhandoff`;
  const compiled = {
    text: fullText,
    images: [{ ref: "image_attachment_1", imageUrl: "data:image/png;base64,AA==" }],
  };
  const prepared = await prepareChatGptWebContext(broker, compiled, true, 60_000, "bootstrap-test");
  const contextToken = prepared.text.match(/context_[A-Za-z0-9_-]{32}/)?.[0];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--broker-socket", socketPath],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "context-bootstrap-test", version: "1.0.0" });

  try {
    expect(contextToken).toBeDefined();
    expect(prepared.text.length).toBeLessThan(500);
    expect(prepared.text).not.toContain("full harness");
    expect(prepared.images).toEqual(compiled.images);

    await client.connect(transport);
    const tool = (await client.listTools()).tools.find(candidate => candidate.name === "codex_read_context");
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tool?.inputSchema.properties).toEqual({
      context_token: { type: "string", minLength: 20, maxLength: 256 },
    });
    const result = await client.callTool({
      name: "codex_read_context",
      arguments: { context_token: contextToken },
    });
    expect(result.isError).not.toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe(fullText);
    expect(result.structuredContent).toBeUndefined();

    prepared.release();
    const expired = await client.callTool({
      name: "codex_read_context",
      arguments: { context_token: contextToken },
    });
    expect(expired.isError).toBe(true);
    expect((expired.content as Array<{ text: string }>)[0]?.text).toContain("context token is invalid, expired, or revoked");
  } finally {
    await client.close().catch(() => {});
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("legacy prompt transport remains fully inline", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-context-legacy-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const compiled = { text: "legacy full prompt", images: [] };
  try {
    const prepared = await prepareChatGptWebContext(broker, compiled, false, 60_000, "legacy-test");
    expect(prepared.text).toBe(compiled.text);
    expect(prepared.images).toBe(compiled.images);
    prepared.release();
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
