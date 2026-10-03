import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker-client";
import { startTurnBrokerServer } from "../src/adapters/chatgpt-web/turn-broker-server";

// No owner, model, MCP or agent: isolate concurrent pipe RPC delivery itself.
test.each([5000, null])("held broker reply survives sibling RPC closure and GC (timeout=%s)", async timeout => {
  const root = mkdtempSync(join(tmpdir(), "cgw-delayed-"));
  const endpoint = defaultBrokerEndpoint(root);
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const server = await startTurnBrokerServer(endpoint, async request => {
    if (request.method === "owner_wait_retirement") {
      entered();
      await held;
      return { retired: true };
    }
    return { acknowledged: true };
  });
  const abort = new AbortController();
  const result = callTurnBroker<{ retired: boolean }>(endpoint, { method: "owner_wait_retirement" }, timeout, abort.signal);
  void result.catch(() => {});
  // This is a bounded regression experiment, not a production work deadline.
  const cleanupTimer = setTimeout(() => abort.abort(), 3000);
  try {
    await Promise.race([started, result.then(() => { throw new Error("held response arrived before release"); })]);
    for (let index = 0; index < 3; index += 1) {
      expect(await callTurnBroker<{ acknowledged: boolean }>(endpoint, { method: "owner_status" })).toEqual({ acknowledged: true });
    }
    Bun.gc(true);
    release();
    expect(await result).toEqual({ retired: true });
  } finally {
    clearTimeout(cleanupTimer);
    release();
    abort.abort();
    await result.catch(() => {});
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
