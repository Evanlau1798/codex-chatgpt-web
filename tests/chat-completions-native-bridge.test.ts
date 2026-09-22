import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { parseChatCompletion } from "../src/chat-completions/contract";
import { NativeChatCompletionBridge } from "../src/chat-completions/native-bridge";
import { parseRequest } from "../src/responses/parser";
import { extractChatGptTurnEnvironment, extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";
import { chatCompletionRequest } from "../src/chat-completions/http";
import { nativeChatToolCallsLive, responseRequest } from "../src/server";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web";
import { TurnBroker, callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { ChatGptAccountSafety } from "../src/adapters/chatgpt-web/account-safety";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";

const tools = [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }];
const first = () => parseChatCompletion({ model: "chatgpt-web/high", messages: [{ role: "user", content: "Read input.txt and report it" }], tools });

test("native Chat Completions hands one browser turn's tool result back without another user send", async () => {
  const bodies: any[] = [];
  const bridge = new NativeChatCompletionBridge(async req => {
    const body = await req.json() as any; bodies.push(body);
    return Response.json({ status: "completed", end_turn: bodies.length === 2, output: bodies.length === 1
      ? [{ type: "function_call", call_id: "call_native_1", name: "read", arguments: '{"path":"input.txt"}' }]
      : [{ type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "# Done\ninput" }] }] });
  });
  const config = { ...defaultConfig(), useEnhancedWebSessionMode: true };
  const initial = await bridge.execute(first(), config, new AbortController().signal, () => {});
  expect(initial.result?.finishReason).toBe("tool_calls");
  const call = initial.result!.tool_calls![0]!;
  expect(call.id).toBe("call_native_1");
  const next = parseChatCompletion({ model: "chatgpt-web/high", messages: [
    { role: "user", content: "Read input.txt and report it" },
    { role: "assistant", content: null, tool_calls: [call] },
    { role: "tool", tool_call_id: call.id, content: "input" },
  ], tools });
  const final = await bridge.execute(next, config, new AbortController().signal, () => {});
  expect(final.result).toEqual({ content: "# Done\ninput", finishReason: "stop" });
  expect(bodies).toHaveLength(2);
  expect(bodies[0].client_metadata["x-codex-turn-metadata"]).toBe(bodies[1].client_metadata["x-codex-turn-metadata"]);
  expect(bodies[1].input.filter((item: any) => item.role === "user")).toHaveLength(2);
  expect(bodies[1].input.at(-1)).toMatchObject({ type: "function_call_output", call_id: call.id, output: "input" });
  for (const body of bodies) {
    const parsed = parseRequest(body);
    const environment = extractChatGptTurnEnvironment(parsed);
    expect(environment.sandboxPolicy.type).toBe("readOnly");
    expect(environment.cwd).toContain("api-client");
    expect(extractChatGptTurnUserRevision(parsed)).toBeDefined();
  }
});

test("native bridge rejects a wrong tool result without starting another Web turn", async () => {
  let sends = 0;
  const bridge = new NativeChatCompletionBridge(async () => {
    sends++;
    return Response.json({ status: "completed", output: [{ type: "function_call", call_id: "call_native_2", name: "read", arguments: '{"path":"input.txt"}' }] });
  });
  const config = { ...defaultConfig(), useEnhancedWebSessionMode: true };
  const initial = await bridge.execute(first(), config, new AbortController().signal, () => {});
  const call = initial.result!.tool_calls![0]!;
  const forged = parseChatCompletion({ model: "chatgpt-web/high", messages: [
    { role: "user", content: "DIFFERENT" },
    { role: "assistant", content: null, tool_calls: [call] },
    { role: "tool", tool_call_id: call.id, content: "input" },
  ], tools });
  await expect(bridge.execute(forged, config, new AbortController().signal, () => {})).rejects.toMatchObject({ status: 409 });
  expect(sends).toBe(1);
});

test("parallel clients cannot deliver one session's tool result to another Web turn", async () => {
  let sends = 0;
  const bridge = new NativeChatCompletionBridge(async () => {
    sends++;
    return Response.json({ status: "completed", output: [{ type: "function_call", call_id: `call_owner_${sends}`,
      name: "read", arguments: '{"path":"input.txt"}' }] });
  });
  const config = { ...defaultConfig(), useEnhancedWebSessionMode: true };
  const a = await bridge.execute(first(), config, new AbortController().signal, () => {});
  const bInput = parseChatCompletion({ model: "chatgpt-web/high", messages: [{ role: "user", content: "Read B" }], tools });
  const b = await bridge.execute(bInput, config, new AbortController().signal, () => {});
  const bCall = b.result.tool_calls![0]!;
  const mixed = parseChatCompletion({ model: "chatgpt-web/high", messages: [...first().messages,
    { role: "assistant", content: null, tool_calls: [bCall] },
    { role: "tool", tool_call_id: bCall.id, content: "wrong owner" }], tools });
  await expect(bridge.execute(mixed, config, new AbortController().signal, () => {})).rejects.toMatchObject({ status: 409 });
  expect(a.result.tool_calls![0]!.id).not.toBe(bCall.id);
  expect(sends).toBe(2);
});

test("parallel tool results may arrive in completion order while preserving their call IDs", async () => {
  let rounds = 0;
  const bridge = new NativeChatCompletionBridge(async req => {
    const body = await req.json() as any;
    rounds++;
    if (rounds === 2) expect(body.input.slice(-2).map((value: any) => value.call_id)).toEqual(["call_second", "call_first"]);
    return Response.json({ status: "completed", end_turn: rounds === 2, output: rounds === 1
      ? ["call_first", "call_second"].map(call_id => ({ type: "function_call", call_id, name: "read", arguments: '{"path":"input.txt"}' }))
      : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }] });
  });
  const config = { ...defaultConfig(), useEnhancedWebSessionMode: true };
  const input = first();
  const firstResult = await bridge.execute(input, config, new AbortController().signal, () => {});
  const calls = firstResult.result.tool_calls!;
  const continued = parseChatCompletion({ model: input.model, messages: [...input.messages,
    { role: "assistant", content: "", tool_calls: calls },
    ...calls.toReversed().map(call => ({ role: "tool", tool_call_id: call.id, content: call.id }))], tools });
  expect((await bridge.execute(continued, config, new AbortController().signal, () => {})).result.content).toBe("done");
  expect(rounds).toBe(2);
});

test("a tool call with assistant text resumes only when the client replays that exact text", async () => {
  let rounds = 0;
  const bridge = new NativeChatCompletionBridge(async () => Response.json({ status: "completed", end_turn: ++rounds === 2,
    output: rounds === 1 ? [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking the file." }] },
      { type: "function_call", call_id: "call_with_text", name: "read", arguments: '{"path":"input.txt"}' },
    ] : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] }] }));
  const config = { ...defaultConfig(), useEnhancedWebSessionMode: true };
  const input = first();
  const initial = await bridge.execute(input, config, new AbortController().signal, () => {});
  expect(initial.result.content).toBe("Checking the file.");
  const call = initial.result.tool_calls![0]!;
  const next = parseChatCompletion({ model: input.model, messages: [...input.messages,
    { role: "assistant", content: "Checking the file.", tool_calls: [call] },
    { role: "tool", tool_call_id: call.id, content: "ok" }], tools });
  expect((await bridge.execute(next, config, new AbortController().signal, () => {})).result.content).toBe("Done.");
  expect(rounds).toBe(2);
});

test("a failed native continuation retires the original turn instead of stranding its broker tool", async () => {
  let rounds = 0, retirements = 0;
  const bridge = new NativeChatCompletionBridge(async () => Response.json(++rounds === 1
    ? { status: "completed", output: [{ type: "function_call", call_id: "call_failed", name: "read", arguments: '{"path":"input.txt"}' }] }
    : { status: "failed", error: { code: "upstream_server_error" } }), Date.now,
  { retire: async () => { retirements++; } });
  const config = { ...defaultConfig(), useEnhancedWebSessionMode: true };
  const input = first();
  const call = (await bridge.execute(input, config, new AbortController().signal, () => {})).result.tool_calls![0]!;
  const next = parseChatCompletion({ model: input.model, messages: [...input.messages,
    { role: "assistant", content: null, tool_calls: [call] },
    { role: "tool", tool_call_id: call.id, content: "ok" }], tools });
  await expect(bridge.execute(next, config, new AbortController().signal, () => {})).rejects.toMatchObject({ status: 502 });
  expect(retirements).toBe(1);
  await expect(bridge.execute(next, config, new AbortController().signal, () => {})).rejects.toMatchObject({ status: 409 });
  expect(rounds).toBe(2);
});

test("a rejected first tool batch also retires the browser owner", async () => {
  let retirements = 0;
  const bridge = new NativeChatCompletionBridge(async () => Response.json({ status: "completed", output: [
    { type: "function_call", call_id: "call_invalid", name: "undeclared", arguments: "{}" },
  ] }), Date.now, { retire: async () => { retirements++; } });
  await expect(bridge.execute(first(), { ...defaultConfig(), useEnhancedWebSessionMode: true },
    new AbortController().signal, () => {})).rejects.toMatchObject({ code: "model_protocol_error" });
  expect(retirements).toBe(1);
});

test("a broker-retired tool call is rejected before another Web request", async () => {
  let sends = 0, retirements = 0;
  const bridge = new NativeChatCompletionBridge(async () => {
    sends++;
    return Response.json({ status: "completed", output: [
      { type: "function_call", call_id: "call_broker_expired", name: "read", arguments: '{"path":"input.txt"}' },
    ] });
  }, Date.now, { isLive: () => false, retire: async () => { retirements++; } });
  const config = { ...defaultConfig(), useEnhancedWebSessionMode: true };
  const input = first();
  const call = (await bridge.execute(input, config, new AbortController().signal, () => {})).result.tool_calls![0]!;
  const next = parseChatCompletion({ model: input.model, messages: [...input.messages,
    { role: "assistant", content: null, tool_calls: [call] },
    { role: "tool", tool_call_id: call.id, content: "late" }], tools });
  await expect(bridge.execute(next, config, new AbortController().signal, () => {})).rejects.toMatchObject({ status: 409 });
  expect(sends).toBe(1);
  expect(retirements).toBe(1);
});

test("native API continuation requires every broker call to remain within its original invoke deadline", () => {
  const now = 10_000;
  const active = { isActive: () => true, outstanding: () => [
    { callId: "a", invokeDeadlineAt: now + 1 },
    { callId: "b", invokeDeadlineAt: now },
  ] };
  expect(nativeChatToolCallsLive(active, ["a"], now)).toBe(true);
  expect(nativeChatToolCallsLive(active, ["a", "b"], now)).toBe(false);
  expect(nativeChatToolCallsLive(active, ["missing"], now)).toBe(false);
  expect(nativeChatToolCallsLive({ ...active, isActive: () => false }, ["a"], now)).toBe(false);
  expect(nativeChatToolCallsLive({ isActive: () => true,
    outstanding: () => [{ callId: "a" }] }, ["a"], now)).toBe(false);
});

test("standard Chat Completions HTTP carries native broker call IDs through the existing Responses adapter", async () => {
  const config = { ...defaultConfig(), useEnhancedWebSessionMode: true };
  let adapterRounds = 0;
  const bridge = new NativeChatCompletionBridge((req, settings) => responseRequest(req, settings,
    () => ({ name: "api-native-test", async runTurn(parsed, _incoming, emit) {
      adapterRounds++;
      if (adapterRounds === 1) {
        expect(parsed.context.tools?.map(tool => tool.name)).toContain("read");
        emit({ type: "tool_call_start", id: "call_http_native", name: "read" });
        emit({ type: "tool_call_delta", arguments: '{"path":"input.txt"}' });
        emit({ type: "tool_call_end" });
        emit({ type: "done", endTurn: false });
      } else {
        expect(parsed.context.messages.some(message => message.role === "toolResult"
          && message.toolCallId === "call_http_native")).toBe(true);
        emit({ type: "text_delta", text: "# Finished" });
        emit({ type: "done", endTurn: true });
      }
    } }), { rememberState: false }));
  const send = (messages: unknown[]) => chatCompletionRequest(new Request("http://127.0.0.1/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/high", messages, tools }),
  }), config, new AbortController().signal, async () => { throw new Error("legacy worker must not run"); }, bridge);
  const initial = await (await send([{ role: "user", content: "Read input.txt" }])).json() as any;
  expect(initial.choices[0].finish_reason).toBe("tool_calls");
  const call = initial.choices[0].message.tool_calls[0];
  expect(call.id).toBe("call_http_native");
  const final = await (await send([{ role: "user", content: "Read input.txt" },
    { role: "assistant", content: null, tool_calls: [call] },
    { role: "tool", tool_call_id: call.id, content: "file contents" }])).json() as any;
  expect(final.choices[0].message.content).toBe("# Finished");
  expect(adapterRounds).toBe(2);
});

test("production adapter resumes a broker-owned Web generation after an API client tool result", async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-api-native-"));
  const socket = join(root, "broker.sock");
  const broker = TurnBroker.forSocket(socket);
  const safety = new ChatGptAccountSafety(join(root, "safety.json"));
  const apiEnvironments = new ChatGptThreadEnvironmentStore();
  const config = { ...defaultConfig("full"), useEnhancedWebSessionMode: true, useEnhancedOutputTunnel: false,
    brokerSocketPath: socket };
  let browserStarts = 0;
  const worker = { async run(turn: BrowserTurn): Promise<string> {
    browserStarts++;
    const prepared = await turn.prepare();
    try {
      const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
      expect(token).toBeDefined();
      const { bindingId } = await callTurnBroker<{ bindingId: string }>(socket, { method: "claim", token });
      const invocation = callTurnBroker<any>(socket, { method: "invoke", bindingId,
        wireName: "read", freeform: false, arguments: { path: "input.txt" } }, 90_000);
      const progress = turn.externalProgress!;
      while (!progress.snapshot().lastToolBatchRevision) {
        await progress.waitForChange(progress.snapshot().revision, turn.abortSignal);
      }
      await progress.acknowledgeToolBatch(progress.snapshot().lastToolBatchRevision);
      const result = await invocation;
      expect(JSON.stringify(result)).toContain("file contents");
      turn.onTextDelta("# Done");
      return "# Done";
    } finally { prepared.release(); }
  } };
  const bridge = new NativeChatCompletionBridge((req, settings) => responseRequest(req, settings,
    provider => createChatGptWebAdapter({ ...provider, chatgptWeb: { ...provider.chatgptWeb,
      brokerSocketPath: socket, threadEnvironmentStatePath: join(root, "thread-environments.json") } },
    { broker, worker, accountSafety: safety, environmentStore: apiEnvironments }), { rememberState: false }));
  try {
    const input = first();
    const initial = await Promise.race([bridge.execute(input, config, new AbortController().signal, () => {}),
      Bun.sleep(20_000).then(() => { throw new Error("native broker first round timed out"); })]);
    const call = initial.result.tool_calls![0]!;
    const next = parseChatCompletion({ model: input.model, messages: [...input.messages,
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: "file contents" }], tools });
    const final = await Promise.race([bridge.execute(next, config, new AbortController().signal, () => {}),
      Bun.sleep(20_000).then(() => { throw new Error("native broker continuation timed out"); })]);
    expect(final.result).toEqual({ content: "# Done", finishReason: "stop" });
    expect(browserStarts).toBe(1);
    expect(existsSync(join(root, "thread-environments.json"))).toBe(false);
  } finally {
    chatGptTurnSessions.clear();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
