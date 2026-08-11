import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_CONTEXT_ARCHIVE_CHUNK_CHARS,
  prepareChatGptWebContext,
} from "../src/adapters/chatgpt-web/context-bootstrap";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";

const contextText = (messages: Array<Record<string, unknown>>): string => [
  "Act as the model backend for the Codex task encoded below.",
  "<codex_context_json>",
  JSON.stringify({ version: 3, system: ["system contract"], messages }),
  "</codex_context_json>",
  "<codex_transport_resume>",
  "Execute the latest active user request now.",
  "</codex_transport_resume>",
].join("\n");

async function clientFor(socketPath: string): Promise<Client> {
  const client = new Client({ name: "context-bootstrap-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--broker-socket", socketPath],
    cwd: process.cwd(),
    stderr: "pipe",
  }));
  return client;
}

test("beta transport keeps prompts within the measured boundary inline", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-context-inline-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const compiled = {
    text: "complete prompt",
    images: [],
    turnToken: "turn_123456789012345678901234",
    bootstrapLimits: { chars: 8_192, tokens: 8_192 },
  };
  try {
    const prepared = await prepareChatGptWebContext(broker, compiled, true, 60_000, "inline-test");
    expect(prepared.text).toBe(compiled.text);
    expect(prepared.transport).toBe("inline");
    expect(prepared.inlineChars).toBe(compiled.text.length);
    expect(prepared.modelInputText).toBeUndefined();
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool-capable prompts above the stable 94208 character boundary use the archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-context-stable-limit-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const turnToken = await broker.register({
    cwd: process.cwd(), roots: [process.cwd()], writableRoots: [], sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [],
  }, 60_000, "stable-limit-test");
  const compiled = compileChatGptWebPrompt({
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      messages: [
        { role: "user", content: `old-${"x".repeat(308_616)}`, timestamp: 1 },
        { role: "user", content: "CODEX_LATEST_USER_PROMPT_JSON: continue", timestamp: 2 },
      ],
    },
    stream: true,
    options: { reasoning: "medium" },
  }, { localToolsEnabled: true, solAvailable: true, proAvailable: false }, turnToken);

  try {
    expect(compiled.bootstrapLimits?.chars).toBe(94_208);
    const prepared = await prepareChatGptWebContext(broker, compiled, true, 60_000, "stable-limit-test");
    expect(prepared.transport).toBe("native2-archive");
    expect(prepared.text.length).toBeLessThanOrEqual(94_208);
    expect(prepared.inlineChars).toBe(prepared.text.length);
    expect(prepared.archiveChars).toBeGreaterThan(200_000);
    expect(prepared.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.text).toContain("CODEX_LATEST_USER_PROMPT_JSON");
    prepared.release();
  } finally {
    broker.revoke(turnToken);
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("archive bootstrap preserves the lazy stateful tool contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-context-tool-contract-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const environment = {
    cwd: process.cwd(),
    roots: [process.cwd()],
    writableRoots: [],
    sandboxPolicy: { type: "readOnly" as const, networkAccess: false },
    tools: [],
  };
  const turnToken = await broker.register(environment, 60_000, "tool-contract-test");
  const compiled = compileChatGptWebPrompt({
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      messages: [
        { role: "toolResult", toolCallId: "old", toolName: "exec", content: "x".repeat(20_000), isError: false, timestamp: 1 },
        { role: "user", content: "use the requested stateful tool", timestamp: 2 },
      ],
    },
    stream: true,
    options: { reasoning: "high" },
  }, { localToolsEnabled: true, solAvailable: true, proAvailable: true }, turnToken);
  compiled.bootstrapLimits = { chars: 8_192, tokens: 8_192 };

  try {
    const prepared = await prepareChatGptWebContext(broker, compiled, true, 60_000, "tool-contract-test");
    expect(prepared.transport).toBe("native2-archive");
    expect(prepared.text).toContain("codex_tool_inventory");
    expect(prepared.text).toContain("tool_search");
    expect(prepared.text).toContain("same Web conversation");
    expect(prepared.text).toContain("Never emulate a stateful or persistent tool with codex_exec");
    prepared.release();
  } finally {
    broker.revoke(turnToken);
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversize beta prompt maximizes a complete bootstrap and archives only omitted messages", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-context-bootstrap-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const turnToken = await broker.register({
    cwd: process.cwd(),
    roots: [process.cwd()],
    writableRoots: [process.cwd()],
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [process.cwd()], networkAccess: false },
    tools: [],
  }, 60_000, "bootstrap-test");
  const oldHistory = `PRE_COMPACT_REPLAY_${"x".repeat(20_000)}`;
  const handoff = "CODEX_COMPACTION_HANDOFF: preserve this exact state";
  const latest = "CODEX_LATEST_USER_PROMPT_JSON: steering after compact";
  const fullText = contextText([
    { role: "user", content: oldHistory },
    ...Array.from({ length: 24 }, (_value, index) => ({
      role: index % 2 === 0 ? "assistant" : "tool_result",
      content: `RECENT_${index}_${"r".repeat(300)}`,
    })),
    { role: "user", content: handoff },
    { role: "user", content: latest },
  ]);
  const compiled = {
    text: fullText,
    images: [{ ref: "image_attachment_1", imageUrl: "data:image/png;base64,AA==" }],
    turnToken,
    bootstrapLimits: { chars: 8_192, tokens: 8_192 },
  };
  const prepared = await prepareChatGptWebContext(broker, compiled, true, 60_000, "bootstrap-test");
  const contextToken = prepared.text.match(/context_[A-Za-z0-9_-]{32}/)?.[0];
  const client = await clientFor(socketPath);

  try {
    expect(contextToken).toBeDefined();
    expect(prepared.transport).toBe("native2-archive");
    expect(prepared.text.length).toBeLessThanOrEqual(8_192);
    expect(prepared.text.length).toBeGreaterThan(7_000);
    expect(prepared.text).toContain(handoff);
    expect(prepared.text).toContain(latest);
    expect(prepared.text).not.toContain("PRE_COMPACT_REPLAY");
    expect(prepared.modelInputText).toBe(fullText);
    expect(prepared.archiveChars).toBeGreaterThan(20_000);
    expect(prepared.images).toEqual(compiled.images);

    const blocked = await client.callTool({
      name: "codex_tool_inventory",
      arguments: { turn_token: turnToken, include_schema: false },
    });
    expect(blocked.isError).toBe(true);
    expect((blocked.content as Array<{ text: string }>)[0]?.text).toContain("context archive");

    const archive = await client.callTool({
      name: "codex_tool_inventory",
      arguments: {
        turn_token: contextToken,
        query: "__codex_context__:0",
        include_schema: false,
      },
    });
    const archiveText = (archive.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(archive.isError).not.toBe(true);
    expect(archive.structuredContent).toBeUndefined();
    expect(archiveText).toContain("CODEX_CONTEXT_ARCHIVE v=1 index=0 total=1");
    expect(archiveText).toContain("PRE_COMPACT_REPLAY");
    expect(archiveText).not.toContain(handoff);
    expect(archiveText).not.toContain(latest);
    expect(archiveText).toContain("next_query=null");

    const allowed = await client.callTool({
      name: "codex_tool_inventory",
      arguments: { turn_token: turnToken, include_schema: false },
    });
    expect(allowed.isError).not.toBe(true);

    prepared.release();
    const expired = await client.callTool({
      name: "codex_tool_inventory",
      arguments: {
        turn_token: contextToken,
        query: "__codex_context__:0",
        include_schema: false,
      },
    });
    expect(expired.isError).toBe(true);
    expect((expired.content as Array<{ text: string }>)[0]?.text).toContain("context token is invalid, expired, or revoked");
  } finally {
    await client.close().catch(() => {});
    broker.revoke(turnToken);
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("archive chunks use complete indexed frames above the MCP result ceiling", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-context-chunks-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const omittedA = `OMITTED_A_${"z".repeat(300_000)}`;
  const omittedB = `OMITTED_B_${"y".repeat(300_000)}`;
  const fullText = contextText([
    { role: "user", content: omittedA },
    { role: "assistant", content: omittedB },
    { role: "user", content: "CODEX_LATEST_USER_PROMPT_JSON: latest" },
  ]);
  const turnToken = await broker.register({
    cwd: process.cwd(), roots: [], writableRoots: [], sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [],
  }, 60_000, "chunk-test");
  const prepared = await prepareChatGptWebContext(broker, {
    text: fullText,
    images: [],
    turnToken,
    bootstrapLimits: { chars: 4_096, tokens: 4_096 },
  }, true, 60_000, "chunk-test");
  const contextToken = prepared.text.match(/context_[A-Za-z0-9_-]{32}/)?.[0]!;
  const client = await clientFor(socketPath);
  try {
    const first = await client.callTool({
      name: "codex_tool_inventory",
      arguments: { turn_token: contextToken, query: "__codex_context__:0", include_schema: false },
    });
    const firstText = (first.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(firstText).toContain("index=0 total=2");
    expect(firstText).toContain("next_query=__codex_context__:1");
    const skipped = await client.callTool({
      name: "codex_tool_inventory",
      arguments: { turn_token: contextToken, query: "__codex_context__:2", include_schema: false },
    });
    expect(skipped.isError).toBe(true);
    const second = await client.callTool({
      name: "codex_tool_inventory",
      arguments: { turn_token: contextToken, query: "__codex_context__:1", include_schema: false },
    });
    const secondText = (second.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(secondText).toContain("index=1 total=2");
    expect(secondText).toContain("next_query=null");
    expect(`${firstText}${secondText}`).toContain("OMITTED_A_");
    expect(`${firstText}${secondText}`).toContain("OMITTED_B_");
  } finally {
    await client.close().catch(() => {});
    prepared.release();
    broker.revoke(turnToken);
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("legacy and read-only prompt transports remain fully inline", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-context-legacy-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    for (const compiled of [
      { text: "legacy full prompt", images: [], turnToken: "turn_123456789012345678901234", bootstrapLimits: { chars: 1, tokens: 1 } },
      { text: "read-only full prompt", images: [], bootstrapLimits: { chars: 1, tokens: 1 } },
    ]) {
      const prepared = await prepareChatGptWebContext(
        broker,
        compiled,
        compiled.text.startsWith("read-only"),
        60_000,
        "inline-test",
      );
      expect(prepared.text).toBe(compiled.text);
      expect(prepared.transport).toBe("inline");
      prepared.release();
    }
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
