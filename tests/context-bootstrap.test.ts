import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
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

test("bounded specialist instructions remain byte-for-byte inline", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-context-inline-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const compiled = {
    text: `specialist instructions\n${"x".repeat(12_000)}`,
    images: [],
    turnToken: "turn_123456789012345678901234",
    bootstrapLimits: { chars: 94_208, tokens: 94_208 },
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

test("a single oversized serialized text run uses the archive below the total bootstrap limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-context-text-run-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const turnToken = await broker.register({
    cwd: process.cwd(),
    roots: [],
    writableRoots: [],
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    tools: [],
  }, 60_000, "text-run-test");
  const fullText = contextText([
    {
      role: "toolResult",
      toolCallId: "large-result",
      content: "x".repeat(20_049),
      isError: false,
    },
    { role: "user", content: "summarize the completed probe" },
  ]);

  try {
    expect(fullText.length).toBeLessThan(94_208);
    const prepared = await prepareChatGptWebContext(broker, {
      text: fullText,
      images: [],
      turnToken,
      bootstrapLimits: { chars: 94_208, tokens: 94_208 },
    }, true, 60_000, "text-run-test");

    expect(prepared.transport).toBe("native2-archive");
    expect(Math.max(...prepared.text.split(/\r?\n/).map(line => line.length))).toBeLessThanOrEqual(12_288);
    expect(prepared.text).not.toContain("x".repeat(12_289));
    expect(prepared.archiveChars).toBeGreaterThan(20_049);
    prepared.release();
  } finally {
    broker.revoke(turnToken);
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("large advertised tool inventories remain complete through the context archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-context-tools-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const turnToken = await broker.register({
    cwd: process.cwd(), roots: [], writableRoots: [], sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [],
  }, 60_000, "tool-inventory-test");
  const toolNames = Array.from({ length: 258 }, (_value, index) => (
    `mcp__generic_surface_${String(index).padStart(3, "0")}_${"n".repeat(24)}__operation_${String(index).padStart(3, "0")}`
  ));
  const compiled = compileChatGptWebPrompt({
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      messages: [{ role: "user", content: "Inspect the repository with the available tools", timestamp: 1 }],
      tools: toolNames.map(wireName => {
        const splitAt = wireName.lastIndexOf("__");
        return {
          namespace: wireName.slice(0, splitAt),
          name: wireName.slice(splitAt + 2),
          description: "Generic read-only capability",
          parameters: { type: "object", properties: {} },
        };
      }),
    },
    stream: true,
    options: { reasoning: "high" },
  }, { localToolsEnabled: true, solAvailable: true, proAvailable: true }, turnToken);

  let client: Client | undefined;
  try {
    expect(Math.max(...compiled.text.split(/\r?\n/).map(line => line.length))).toBeGreaterThan(12_288);
    const prepared = await prepareChatGptWebContext(broker, compiled, true, 60_000, "tool-inventory-test");
    expect(prepared.transport).toBe("native2-archive");
    expect(Math.max(...prepared.text.split(/\r?\n/).map(line => line.length))).toBeLessThanOrEqual(12_288);

    const contextToken = prepared.text.match(/context_[A-Za-z0-9_-]{32}/)?.[0];
    expect(contextToken).toBeDefined();
    client = await clientFor(socketPath);
    const archiveParts: string[] = [];
    for (let index = 0; ; index += 1) {
      const result = await client.callTool({
        name: "codex_tool_inventory",
        arguments: { turn_token: contextToken, query: `__codex_context__:${index}`, include_schema: false },
      });
      expect(result.isError).not.toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
      archiveParts.push(text);
      if (text.includes("next_query=null")) break;
    }
    const transported = `${prepared.text}\n${archiveParts.join("\n")}`;
    for (const toolName of toolNames) expect(transported).toContain(toolName);
    prepared.release();
  } finally {
    await client?.close().catch(() => {});
    broker.revoke(turnToken);
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

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
        turn_token: turnToken,
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

test("a single oversized archive record is transported as valid reconstructable JSON fragments", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-context-record-fragments-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const largeContent = `${"😀\\\"markdown\n".repeat(55_000)}END`;
  const expectedRecord = { kind: "message", index: 0, value: { role: "user", content: largeContent } };
  const fullText = contextText([
    expectedRecord.value,
    { role: "user", content: "CODEX_LATEST_USER_PROMPT_JSON: inspect the deferred document" },
  ]);
  const turnToken = await broker.register({
    cwd: process.cwd(), roots: [], writableRoots: [], sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [],
  }, 60_000, "record-fragment-test");
  const prepared = await prepareChatGptWebContext(broker, {
    text: fullText,
    images: [],
    turnToken,
    bootstrapLimits: { chars: 4_096, tokens: 4_096 },
  }, true, 60_000, "record-fragment-test");
  const contextToken = prepared.text.match(/context_[A-Za-z0-9_-]{32}/)?.[0]!;
  const client = await clientFor(socketPath);

  try {
    const chunks: string[] = [];
    for (let index = 0; ; index += 1) {
      const result = await client.callTool({
        name: "codex_tool_inventory",
        arguments: { turn_token: contextToken, query: `__codex_context__:${index}`, include_schema: false },
      });
      expect(result.isError).not.toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
      const end = text.lastIndexOf("\nCODEX_CONTEXT_ARCHIVE_END");
      chunks.push(text.slice(text.indexOf("\n") + 1, end));
      if (text.includes("next_query=null")) break;
    }

    const archive = chunks.join("");
    const lines = archive.split("\n");
    expect(lines[0]).toBe("CODEX_CONTEXT_ARCHIVE_NDJSON v=2");
    expect(lines.at(-1)).toBe("CODEX_CONTEXT_ARCHIVE_NDJSON_END");
    const records = lines.slice(1, -1).map(line => {
      expect(line.length).toBeLessThanOrEqual(CODEX_CONTEXT_ARCHIVE_CHUNK_CHARS);
      return JSON.parse(line) as Record<string, any>;
    });
    const fragments = records.filter(record => record.kind === "record_fragment");
    expect(fragments.length).toBeGreaterThan(1);
    expect(fragments.map(fragment => fragment.part)).toEqual(fragments.map((_fragment, index) => index));
    expect(new Set(fragments.map(fragment => fragment.parts))).toEqual(new Set([fragments.length]));
    const serialized = fragments.map(fragment => fragment.data).join("");
    expect(createHash("sha256").update(serialized).digest("hex")).toBe(fragments[0]?.sha256);
    expect(JSON.parse(serialized)).toEqual(expectedRecord);
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
