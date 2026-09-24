import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { parseChatCompletion } from "../src/chat-completions/contract";
import { prepareChatCompletion } from "../src/chat-completions/runtime";

const request = (extra: Record<string, unknown> = {}) => ({
  model: "chatgpt-web/gpt-5.6-sol",
  messages: [{ role: "user", content: "inert integration fixture" }], ...extra,
});

test("API resolves a supported v6 effort before browser work", () => {
  const input = parseChatCompletion(request({ reasoning_effort: "medium" }));
  expect(input.reasoningEffort).toBe("medium");
  const { route } = prepareChatCompletion(input, defaultConfig());
  expect(route.adapterEffort).toBe("medium");
  expect(route.modelFamily).toBe("5.6");
});

test("API rejects an unsupported effort instead of silently selecting another mode", () => {
  expect(() => prepareChatCompletion(parseChatCompletion(request({ reasoning_effort: "low" })), defaultConfig())).toThrow();
});

test("API saved storage remains unavailable independently of launcher settings", () => {
  expect(() => parseChatCompletion(request({ store: true }))).toThrow();
});

import { NativeChatCompletionBridge } from "../src/chat-completions/native-bridge";
import { createChatCompletionExecutor } from "../src/chat-completions/runtime";
import { ChatGptAccountSafety } from "../src/adapters/chatgpt-web/account-safety";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tools = [{ type: "function", function: { name: "read", parameters: { type: "object" } } }];

test("native API binds effective effort and forces Temporary across continuation and lifecycle checks", async () => {
  let calls = 0, liveChecks = 0;
  const configs: unknown[] = [], bodies: any[] = [];
  const bridge = new NativeChatCompletionBridge(async (req, config) => {
    configs.push(config); bodies.push(await req.json()); calls++;
    return Response.json({ status: "completed", end_turn: calls === 2, output: calls === 1
      ? [{ type: "function_call", call_id: "call_effort", name: "read", arguments: "{}" }]
      : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }] });
  }, Date.now, { isLive(_body, _calls, config) {
    liveChecks++; expect(config.useSavedChats).toBe(false);
    expect(config.experimentalFreshConversationPerTurn).toBe(false); return true;
  } });
  const config = { ...defaultConfig("full"), useEnhancedWebSessionMode: true,
    useSavedChats: true, experimentalFreshConversationPerTurn: true };
  const input = parseChatCompletion(request({ tools }));
  const first = await bridge.execute(input, config, new AbortController().signal, () => {});
  const call = first.result.tool_calls![0]!;
  const next = parseChatCompletion(request({ tools, messages: [...input.messages,
    { role: "assistant", content: null, tool_calls: [call] },
    { role: "tool", tool_call_id: call.id, content: "fixture" }] }));
  // Exercise the execution boundary independently of the public parser.
  await expect(bridge.execute({ ...next, reasoningEffort: "medium" }, config,
    new AbortController().signal, () => {})).rejects.toMatchObject({ status: 409, code: "tool_continuation_conflict" });
  expect(calls).toBe(1); expect(liveChecks).toBe(0);
  const final = await bridge.execute({ ...next, reasoningEffort: "high" }, config,
    new AbortController().signal, () => {});
  expect(final.result.content).toBe("done"); expect(calls).toBe(2); expect(liveChecks).toBe(1);
  for (const settings of configs) expect(settings).toMatchObject({ useSavedChats: false, experimentalFreshConversationPerTurn: false });
  for (const body of bodies) expect(body).toMatchObject({ store: false, reasoning: { effort: "high" } });
  expect(config.useSavedChats).toBe(true); // Do not mutate the user's global setting.
});

test("direct API pins family/effort and ignores global saved/fresh settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "api-family-"));
  try {
    const execute = createChatCompletionExecutor({ safety: new ChatGptAccountSafety(join(root, "safety.json")), worker(provider) {
      expect(provider.chatgptWeb).toMatchObject({ useSavedChats: false, experimentalFreshConversationPerTurn: false });
      return { async run(turn) { expect(turn.modelFamily).toBe("5.6"); expect(turn.reasoning).toBe("high"); return "done"; } };
    } });
    await execute(parseChatCompletion(request()), { ...defaultConfig(), useSavedChats: true,
      experimentalFreshConversationPerTurn: true }, new AbortController().signal, () => {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy API routes reject explicit effort instead of ignoring the request", () => {
  const input = parseChatCompletion(request({ model: "chatgpt-web/high" }));
  expect(() => prepareChatCompletion({ ...input, reasoningEffort: "medium" }, defaultConfig()))
    .toThrow("reasoning_effort");
});
