import { expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { defaultBrokerEndpoint } from "../src/config";
import { callTurnBroker, RemoteTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { observeMcpToolCalls } from "../src/adapters/chatgpt-web/mcp-observation";
import * as diagnostics from "../src/adapters/chatgpt-web/mcp-request-diagnostics";
import { isConnectorContractProbeQuery, verifyCurrentConnectorContract } from "../src/adapters/chatgpt-web/connector-contract";

test("tracking saturation cannot associate an overflow reply with a later turn", async () => {
  const events: any[] = [], sent: unknown[] = []; let received = 0;
  const transport: Transport = { start: async () => {}, close: async () => {},
    onmessage: () => { received++; }, send: async message => { sent.push(message); } };
  observeMcpToolCalls(transport, new Set(["codex_exec"]), event => events.push(event));
  const request = (id: number, token: string) => ({ jsonrpc: "2.0" as const, id, method: "tools/call",
    params: { name: "codex_exec", arguments: { turn_token: token } } });
  const reply = (id: number) => ({ jsonrpc: "2.0" as const, id, result: {} });
  for (let id = 0; id < 1024; id++) transport.onmessage?.(request(id, "private-original-reference"));
  transport.onmessage?.(request(1024, "private-untracked-reference"));
  expect(events.at(-1)).toMatchObject({ event: "uncorrelated_call", reason: "tracking_limit" });
  await transport.send(reply(0)); // Free one slot while the overflow reply is still outstanding.
  transport.onmessage?.(request(1024, "private-new-turn-reference"));
  const stale = reply(1024), later = reply(1024);
  await transport.send(stale); await transport.send(later);
  expect(events.some(e => e.reference_hash === diagnostics.scopeHash("private-new-turn-reference"))).toBeFalse();
  expect(received).toBe(1026);
  expect(sent.slice(-2)).toEqual([stale, later]);
  await transport.send(reply(1));
  expect(events.at(-1)).toMatchObject({ event: "reply_sent", reference_hash: diagnostics.scopeHash("private-original-reference") });
  transport.onclose?.();
  expect(events.at(-1)).toMatchObject({ event: "transport_closed", tracked_calls: 1022 });
});

test("different producer temp roots are distinguished from rejected reserved queries across processes", async () => {
  const root = mkdtempSync(join(tmpdir(), "contract-producer-"));
  const log = spyOn(console, "error").mockImplementation(() => {});
  let producer: any, nonce = "";
  try {
    await assert.rejects(verifyCurrentConnectorContract("Codex Native2", "native", async probe => {
      nonce = probe.nonce;
      const module = new URL("../src/adapters/chatgpt-web/connector-contract.ts", import.meta.url).href;
      const child = Bun.spawn([process.execPath, "--eval",
        `import{readFileSync}from'node:fs';import{recordConnectorContractProbeQuery}from${JSON.stringify(module)};if(!recordConnectorContractProbeQuery(readFileSync(0,'utf8'),'native'))process.exit(1);`],
      { env: { ...process.env, TMP: root, TEMP: root, TMPDIR: root }, stdin: "pipe", stdout: "ignore", stderr: "pipe" });
      child.stdin.write(probe.query); child.stdin.end();
      const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(exit).toBe(0);
      const line = stderr.split("\n").find(row => row.startsWith("[chatgpt-web] connector_probe="));
      expect(line).toBeDefined(); producer = JSON.parse(line!.split("connector_probe=")[1]!);
      expect(existsSync(join(root, "codex-chatgpt-web-contract-probes", nonce + ".json"))).toBeTrue();
    }), /did not execute the current runtime contract probe/);
    const events = log.mock.calls.flat().filter(line => String(line).startsWith("[chatgpt-web] connector_probe="))
      .map(line => JSON.parse(String(line).split("connector_probe=")[1]!));
    expect(events.map(e => e.phase)).toEqual(["expected", "consumed"]);
    expect(producer).toMatchObject({ phase: "produced", nonce_hash: diagnostics.scopeHash(nonce) });
    expect(producer.root_hash).not.toBe(events[0].root_hash);
    expect(events.at(-1)).toMatchObject({ matched: false, nonce_hash: producer.nonce_hash });
    for (const secret of [root, nonce]) expect(JSON.stringify([producer, ...events])).not.toContain(secret);
  } finally { log.mockRestore(); rmSync(root, { recursive: true, force: true }); }
}, 15_000);

test("a duplicate arriving during stdio send cannot resurrect a correlated receipt", async () => {
  const events: any[] = []; let release!: () => void, first = true;
  const transport: Transport = { start: async () => {}, close: async () => {}, send: async () => {
    if (first) { first = false; await new Promise<void>(resolve => { release = resolve; }); }
  } };
  observeMcpToolCalls(transport, new Set(["codex_exec"]), event => events.push(event));
  const request = { jsonrpc: "2.0" as const, id: 1, method: "tools/call", params: { name: "codex_exec" } };
  const reply = { jsonrpc: "2.0" as const, id: 1, result: {} };
  transport.onmessage?.(request); const inFlight = transport.send(reply);
  transport.onmessage?.(request); release(); await inFlight;
  await transport.send(reply);
  expect(events.some(e => e.event === "reply_sent")).toBeFalse();
  transport.onmessage?.(request); await transport.send(reply);
  expect(events.slice(-2).map(e => e.event)).toEqual(["call_received", "reply_sent"]);
});

for (const sink of ["error", "info", "warn"] as const) test("broker results survive a broken diagnostic " + sink + " sink", async () => {
  const root = mkdtempSync(join(tmpdir(), "broker-log-sink-")), socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket), owner = new RemoteTurnBroker(socket);
  let log: ReturnType<typeof spyOn> | undefined;
  try {
    const token = await broker.register({ cwd: root, roots: [root], writableRoots: [], tools: [],
      sandboxPolicy: { type: "readOnly", networkAccess: false } }, undefined, "broken-sink", undefined, true);
    const submit = (text: string) => callTurnBroker(socket, { method: "submit_output", token, outputKind: "final", outputText: text });
    if (sink === "warn") await submit("Original final.");
    log = spyOn(console, sink).mockImplementation(() => { throw new Error("private diagnostic sink failure"); });
    if (sink === "error") {
      const activityId = "activity_" + randomBytes(18).toString("base64url");
      const claimed = await callTurnBroker<{ bindingId: string }>(socket, { method: "claim", token, activityId });
      expect(claimed.bindingId).toMatch(/^binding_/);
      await callTurnBroker(socket, { method: "activity_complete", token, activityId });
    } else if (sink === "info") {
      expect(await submit("Atomic final.")).toEqual({ accepted: true, sequence: 1, duplicate: false });
      expect(await owner.nextOutput(token, 0)).toMatchObject({ text: "Atomic final.", sequence: 1 });
    } else {
      await assert.rejects(submit("Conflicting final."), /conflicting final/);
      expect(await owner.nextOutput(token, 0)).toMatchObject({ text: "Original final.", sequence: 1 });
    }
  } finally { log?.mockRestore(); await broker.close(); rmSync(root, { recursive: true, force: true }); }
});

test("ambiguous IDs remain uncorrelated until every reply settles, then tracking capacity returns", async () => {
  const events: any[] = [];
  const transport: Transport = { start: async () => {}, close: async () => {}, send: async () => {} };
  observeMcpToolCalls(transport, new Set(["codex_exec"]), event => events.push(event));
  const request = { jsonrpc: "2.0" as const, id: 1, method: "tools/call", params: { name: "codex_exec" } };
  const reply = { jsonrpc: "2.0" as const, id: 1, result: {} };
  transport.onmessage?.(request); transport.onmessage?.(request);
  await transport.send(reply);
  transport.onmessage?.(request); // One old reply is still outstanding; this must remain ambiguous.
  expect(events.at(-1)).toMatchObject({ event: "uncorrelated_call", reason: "duplicate_id" });
  await transport.send(reply); await transport.send(reply);
  expect(events.filter(e => e.event === "reply_sent")).toHaveLength(0);
  transport.onmessage?.(request); await transport.send(reply);
  expect(events.slice(-2).map(e => e.event)).toEqual(["call_received", "reply_sent"]);
});

test("unknown tool lookup errors retain only the bounded turn reference hash", async () => {
  const events: any[] = [], token = "turn_private_reference_1234567890";
  const transport: Transport = { start: async () => {}, close: async () => {}, send: async () => {} };
  observeMcpToolCalls(transport, new Set(["codex_exec"]), event => events.push(event));
  transport.onmessage?.({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "private_unknown_tool",
    arguments: { turn_token: token, text: "private arguments" } } });
  await transport.send({ jsonrpc: "2.0", id: 7, result: { isError: true } });
  for (const event of events) expect(event).toMatchObject({ tool: "unknown", reference_hash: diagnostics.scopeHash(token) });
  expect(events.at(-1).is_error).toBeTrue();
  expect(JSON.stringify(events)).not.toContain("private");
});

test("oversized malformed broker tokens never enter the diagnostic hash", async () => {
  const root = mkdtempSync(join(tmpdir(), "broker-hash-bound-")), socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  const log = spyOn(console, "error").mockImplementation(() => {}), hash = spyOn(diagnostics, "scopeHash");
  try {
    await broker.register({ cwd: root, roots: [root], writableRoots: [], tools: [],
      sandboxPolicy: { type: "readOnly", networkAccess: false } }, undefined, "hash-bound");
    await assert.rejects(callTurnBroker(socket, { method: "claim", token: "x".repeat(257),
      activityId: "activity_" + randomBytes(18).toString("base64url") }), /invalid, expired, or revoked/);
    expect(hash.mock.calls.every(([value]) => value.length <= 256)).toBeTrue();
  } finally { hash.mockRestore(); log.mockRestore(); await broker.close(); rmSync(root, { recursive: true, force: true }); }
});

test("rejected reserved queries have positive, content-free classification", () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  const nonce = "0123456789abcdef0123456789abcdef", reference = "turn_private_reference_1234567890";
  try {
    expect(isConnectorContractProbeQuery(`__codex_contract_probe__:stale:${nonce}`, "native", reference)).toBeFalse();
    expect(isConnectorContractProbeQuery("__codex_contract_probe__:stale:private-invalid-nonce", "native", reference)).toBeFalse();
    expect(isConnectorContractProbeQuery("private-normal-inventory-query", "native", reference)).toBeFalse();
    const events = log.mock.calls.flat().filter(line => String(line).startsWith("[chatgpt-web] connector_probe="))
      .map(line => JSON.parse(String(line).split("connector_probe=")[1]!));
    expect(events.map(e => [e.phase, e.reason])).toEqual([["query_rejected", "revision"], ["query_rejected", "pattern"]]);
    expect(events[0].nonce_hash).toBe(diagnostics.scopeHash(nonce));
    expect(events[1].nonce_hash).toBeUndefined();
    expect(events.every(e => e.reference_hash === diagnostics.scopeHash(reference))).toBeTrue();
    for (const secret of [nonce, reference, "private"]) expect(JSON.stringify(events)).not.toContain(secret);
  } finally { log.mockRestore(); }
});
