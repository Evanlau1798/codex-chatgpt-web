import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import type { callTurnBroker as CallTurnBroker } from "../src/adapters/chatgpt-web/turn-broker-client";

// Retain partial-frame and late error/abort coverage without depending on peer EOF.
// Natural process/socket retirement is independently exercised with real children.
const source = readFileSync(new URL("../src/adapters/chatgpt-web/turn-broker-client.ts", import.meta.url), "utf8");
const body = source.slice(source.indexOf("export class TurnBrokerTimeoutError")).replaceAll("export ", "");
const createCall = new Function("createConnection", "opaqueId", "MAX_BROKER_LINE_CHARS", "errorOf",
  new Bun.Transpiler({ loader: "ts" }).transformSync(body) + "\nreturn callTurnBroker;");

for (const unbounded of [false, true]) test(`broker complete frame settlement (unbounded: ${unbounded})`, async () => {
  const socket = Object.assign(new EventEmitter(), {
    ended: false, destroyed: false, unreferenced: false,
    setEncoding() {}, write() {},
    end() { this.ended = true; },
    destroy() { this.destroyed = true; },
    unref() { this.unreferenced = true; },
  });
  const callTurnBroker = createCall(() => socket, () => "request_test", 1_000,
    (value: unknown) => value instanceof Error ? value : new Error(String(value))) as typeof CallTurnBroker;
  const abort = new AbortController();
  let settled = false;
  const call = callTurnBroker("test-pipe", { method: "owner_status" }, unbounded ? null : 3_000, abort.signal);
  void call.then(() => { settled = true; }, () => { settled = true; });
  try {
    socket.emit("connect");
    socket.emit("data", JSON.stringify({ id: "request_test", result: { ready: true } }));
    await setImmediate();
    expect(settled).toBe(false);
    socket.emit("data", "\n");
    socket.emit("error", new Error("late socket error"));
    abort.abort();
    expect(await call).toEqual({ ready: true });
    expect(socket.unreferenced).toBe(true);
    expect(socket.destroyed).toBe(false);
    await setImmediate();
    expect(socket.ended).toBe(true);
    expect(socket.destroyed).toBe(false);
  } finally {
    abort.abort();
    await call.catch(() => {});
  }
});
