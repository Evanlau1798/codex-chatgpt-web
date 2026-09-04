import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import type { callTurnBroker as CallTurnBroker } from "../src/adapters/chatgpt-web/turn-broker-client";

// Exercise the shipped parser and settlement callbacks with explicit physical-close events.
// Real Windows pipe transport is separately covered by turn-broker-lifecycle and manual tool turns.
const source = readFileSync(new URL("../src/adapters/chatgpt-web/turn-broker-client.ts", import.meta.url), "utf8");
const body = source.slice(source.indexOf("export class TurnBrokerTimeoutError")).replaceAll("export ", "");
const createCall = new Function("createConnection", "opaqueId", "MAX_BROKER_LINE_CHARS", "errorOf",
  new Bun.Transpiler({ loader: "ts" }).transformSync(body) + "\nreturn callTurnBroker;");

for (const unbounded of [false, true]) test(`broker complete frame settlement (unbounded: ${unbounded})`, async () => {
  const socket = Object.assign(new EventEmitter(), {
    ended: false, destroyed: false,
    setEncoding() {}, write() {},
    end() { this.ended = true; },
    destroy() { this.destroyed = true; },
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
    await setImmediate();
    if (unbounded) {
      expect(await call).toEqual({ ready: true });
      expect(socket.destroyed).toBe(true);
    } else {
      expect(socket.ended).toBe(true);
      expect(settled).toBe(false);
      socket.emit("end");
      await setImmediate();
      expect(settled).toBe(false);
      socket.emit("close");
      expect(await call).toEqual({ ready: true });
    }
  } finally {
    abort.abort();
    await call.catch(() => {});
  }
});
