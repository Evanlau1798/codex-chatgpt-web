import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { EventEmitter, once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker-client";

test.each([5000, null])("validated broker frame settles before peer EOF (timeout=%s)", async timeout => {
  const root = mkdtempSync(join(tmpdir(), "cgw-frame-"));
  const endpoint = defaultBrokerEndpoint(root);
  if (process.platform !== "win32") mkdirSync(join(root, "runtime"));
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffered = "";
    socket.on("data", chunk => {
      buffered += chunk;
      if (!buffered.includes("\n")) return;
      const request = JSON.parse(buffered.split("\n")[0]!);
      socket.write(JSON.stringify({ id: request.id, result: { acknowledged: true } }) + "\n");
      // Intentionally no socket.end(): this is the actual failing boundary.
    });
  });
  server.listen(endpoint);
  await once(server, "listening");
  try {
    expect(await callTurnBroker<{ acknowledged: boolean }>(endpoint, { method: "owner_status" }, timeout)).toEqual({ acknowledged: true });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

// Retain the original partial-frame/late-error parser coverage, updated for
// frame-based settlement in both bounded and deadline-free calls.
const source = readFileSync(new URL("../src/adapters/chatgpt-web/turn-broker-client.ts", import.meta.url), "utf8");
const body = source.slice(source.indexOf("export class TurnBrokerTimeoutError")).replaceAll("export ", "");
const createCall = new Function("createConnection", "opaqueId", "MAX_BROKER_LINE_CHARS", "errorOf",
  new Bun.Transpiler({ loader: "ts" }).transformSync(body) + "\nreturn callTurnBroker;");
for (const unbounded of [false, true]) test(`broker complete frame settlement (unbounded: ${unbounded})`, async () => {
  const socket = Object.assign(new EventEmitter(), {
    ended: false, destroyed: false, setEncoding() {}, write() {},
    end() { this.ended = true; }, destroy() { this.destroyed = true; },
  });
  const call = createCall(() => socket, () => "request_test", 1000,
    (value: unknown) => value instanceof Error ? value : new Error(String(value))) as typeof callTurnBroker;
  const abort = new AbortController();
  let settled = false;
  const result = call<{ ready: boolean }>("test-pipe", { method: "owner_status" }, unbounded ? null : 3000, abort.signal);
  void result.then(() => { settled = true; }, () => { settled = true; });
  try {
    socket.emit("connect");
    socket.emit("data", JSON.stringify({ id: "request_test", result: { ready: true } }));
    await setImmediate();
    expect(settled).toBeFalse();
    socket.emit("data", "\n");
    socket.emit("error", new Error("late socket error"));
    abort.abort();
    expect(await result).toEqual({ ready: true });
    expect(socket.destroyed).toBeFalse();
  } finally { abort.abort(); await result.catch(() => {}); }
});
