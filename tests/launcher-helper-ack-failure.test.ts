import { expect, test } from "bun:test";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";

test("an asynchronous multipart ACK failure aborts but retains ownership until helper terminal", async () => {
  const client = Object.create(LauncherBrowserHelperClient.prototype) as any;
  const child = {};
  const sent: unknown[] = [];
  const failure = new Error("ACK observer failed");
  const rejected = Promise.reject(failure);
  void rejected.catch(() => {});
  let terminal: Error | undefined;
  let released = false;
  const pending = {
    turn: { onMultipartStageAcknowledged: () => rejected }, sent: true,
    prepared: { multipart: { parts: ["first", "last"] }, release: () => { released = true; } },
    reject: (error: Error) => { terminal = error; },
    resolve: () => { throw new Error("local failure cannot succeed"); },
    localFailure: undefined as Error | undefined,
  };
  client.child = child;
  client.pending = new Map([["ack-failure", pending]]);
  client.send = async (message: unknown) => { sent.push(message); };
  client.handleLine(child, JSON.stringify({ type: "event", id: "ack-failure", event: "multipart_stage_acknowledged", stageIndex: 1 }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(sent).toEqual([{ type: "abort", id: "ack-failure" }]);
  expect(pending.localFailure).toBe(failure);
  expect(client.pending.has("ack-failure")).toBe(true);
  expect(terminal).toBeUndefined();
  expect(released).toBe(false);
  client.handleLine(child, JSON.stringify({ type: "error", id: "ack-failure", name: "AbortError", message: "helper aborted" }));
  expect(terminal).toBe(failure);
  expect(client.pending.size).toBe(0);
  expect(released).toBe(true);
});
