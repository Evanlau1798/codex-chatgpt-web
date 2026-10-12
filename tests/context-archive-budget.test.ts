import { expect, test } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnContextStore } from "../src/adapters/chatgpt-web/turn-context-store";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker-client";
import { defaultBrokerEndpoint } from "../src/config";
import { CODEX_CONTEXT_ARCHIVE_CHUNK_CHARS, CODEX_CONTEXT_ARCHIVE_CHUNK_TOKENS } from "../src/adapters/chatgpt-web/context-bootstrap";
import { estimateTokens } from "../src/lib/token-estimate";

test.each([
  "x".repeat(CODEX_CONTEXT_ARCHIVE_CHUNK_CHARS + 1),
  "界".repeat(25_000),
])("oversized unpaged archive reads cannot retire the context fence", text => {
  expect(text.length > CODEX_CONTEXT_ARCHIVE_CHUNK_CHARS
    || estimateTokens(text) > CODEX_CONTEXT_ARCHIVE_CHUNK_TOKENS).toBeTrue();
  const store = new TurnContextStore();
  const token = store.register(text, undefined, "archive-budget", "turn-budget");
  expect(() => store.read(token, undefined, undefined, new Map())).toThrow("__codex_context__:0");
  expect(store.hasIncomplete("turn-budget")).toBeTrue();
});

test("small legacy context reads preserve their exact result", () => {
  const store = new TurnContextStore();
  const text = "small original context";
  const token = store.register(text, undefined, "archive-small", "turn-small");
  expect(store.read(token, undefined, undefined, new Map())).toEqual({ context: text });
  expect(store.hasIncomplete("turn-small")).toBeFalse();
});

test("rejected bulk reads keep final blocked until every bounded page is delivered", async () => {
  const root = mkdtempSync(join(tmpdir(), "context-archive-budget-"));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  const text = Array.from({ length: 1_500 }, (_, index) => JSON.stringify({
    kind: "message", index, value: `sentinel-${index}-${"payload ".repeat(10)}`,
  })).join("\n");
  try {
    const token = await broker.register({ cwd: root, roots: [root], writableRoots: [],
      sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [] }, undefined, "archive-budget", undefined, true);
    const context = await broker.registerContext(text, undefined, "archive-budget", token);
    await assert.rejects(callTurnBroker(socket, { method: "read_context", token: context }), /__codex_context__:0/);
    const final = () => callTurnBroker(socket, { method: "submit_output", token,
      outputKind: "final", outputText: "complete sentinel" });
    await assert.rejects(final(), /context archive/);
    const chunks: string[] = [];
    for (let index = 0; ; index++) {
      const page = await callTurnBroker<{ context: string; nextIndex: number | null }>(socket,
        { method: "read_context", token: context, index, chunkChars: CODEX_CONTEXT_ARCHIVE_CHUNK_CHARS });
      expect(page.context.length).toBeLessThanOrEqual(CODEX_CONTEXT_ARCHIVE_CHUNK_CHARS);
      expect(estimateTokens(page.context)).toBeLessThanOrEqual(CODEX_CONTEXT_ARCHIVE_CHUNK_TOKENS);
      chunks.push(page.context);
      if (page.nextIndex === null) break;
      await assert.rejects(final(), /context archive/);
    }
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
    expect(await final()).toMatchObject({ accepted: true, duplicate: false });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
