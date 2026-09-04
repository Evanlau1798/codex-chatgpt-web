import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatGptWebAdapter, type ChatGptZeroRiskManualControl } from "../src/adapters/chatgpt-web/index";
import { callTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig, defaultBrokerEndpoint } from "../src/config";
import { startServer } from "../src/server";
import { clearResponseStateMemoryForTests } from "../src/responses/state";

let previousHome: string | undefined;
let testHome: string;
beforeEach(() => {
  previousHome = process.env.CODEX_CHATGPT_WEB_HOME;
  testHome = mkdtempSync(join(tmpdir(), "cgw-manual-http-home-"));
  process.env.CODEX_CHATGPT_WEB_HOME = testHome;
  clearResponseStateMemoryForTests();
});
afterEach(() => {
  clearResponseStateMemoryForTests();
  if (previousHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
  else process.env.CODEX_CHATGPT_WEB_HOME = previousHome;
  rmSync(testHome, { recursive: true, force: true });
});

type Event = Record<string, any>;
async function capture(response: Response, lane: string): Promise<Event[]> {
  expect(response.status).toBe(200);
  const payloads = (await response.text()).split(/\r?\n/).filter(line => line.startsWith("data: "))
    .map(line => line.slice(6));
  const events = payloads.filter(value => value !== "[DONE]").map(value => JSON.parse(value));
  const terminal = lane === "responses" ? "response.completed" : "message_stop";
  expect(events.filter(event => event.type === terminal)).toHaveLength(1);
  expect(events.at(-1).type).toBe(terminal);
  if (lane === "responses") expect(payloads.filter(value => value === "[DONE]")).toHaveLength(1);
  return events;
}

for (const lane of ["responses", "messages"] as const) test(`Zero Risk ${lane} composes HTTP, manual adapter and broker tool continuation`, async () => {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-manual-http-"));
  const config = defaultConfig("full");
  Object.assign(config, {
    port: 0, browserHost: "launcher", browserHostDescriptorPath: join(root, "launcher.json"),
    browserInteractionMode: "manual", appName: config.manualAppName, zeroRiskProEnabled: true,
    brokerSocketPath: defaultBrokerEndpoint(root),
  });
  const broker = TurnBroker.forSocket(config.brokerSocketPath);
  let requestId = "";
  let actor: Promise<void> | undefined;
  const actions: string[] = [];
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) {
      actions.push("prompt-ready");
      requestId = JSON.parse(activity.prompt.match(/<codex_zero_risk_request_json>\n([^\n]+)/)![1]!).request_id;
      expect(activity.prompt).not.toContain("surfaceNonce");
    },
    async waitSent() { actions.push("sent"); },
    waitTerminal() { broker.startSafeTurn(requestId); actions.push("mcp-start"); return new Promise<never>(() => {}); },
    async markStarted() {
      actor = (async () => {
        const claim = await callTurnBroker<{ bindingId: string; activityId: string }>(config.brokerSocketPath, {
          method: "claim", contract: "safe", token: requestId,
        });
        const result = await callTurnBroker<BrokerToolResult>(config.brokerSocketPath, {
          method: "invoke", bindingId: claim.bindingId, wireName: "exec_command", freeform: false,
          arguments: { cmd: "echo manual-http-ok" },
        }, null);
        expect(JSON.stringify(result.content)).toContain("manual-http-ok");
        actions.push("tool-result");
        await callTurnBroker(config.brokerSocketPath, { method: "activity_complete", token: requestId, activityId: claim.activityId });
        broker.completeSafeTurn(requestId, "MANUAL_HTTP_OK");
      })();
      void actor.catch(() => {});
    },
    async end(_path, activity) { actions.push(activity.status); },
    async cancel() {},
  };
  const server = startServer(config, {
    adapterFactory: provider => createChatGptWebAdapter({
      ...provider, chatgptWeb: { ...provider.chatgptWeb,
        threadEnvironmentStatePath: join(root, "environments.json"), lunaCheckpointStatePath: join(root, "checkpoints.json") },
    }, { broker, zeroRiskManualControl: control,
      worker: { run: async () => { throw new Error("Manual HTTP must never start a DOM worker"); } } }),
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const headers = { "content-type": "application/json", "x-claude-code-session-id": `manual-http-${lane}` };
  const post = (body: unknown) => fetch(`${endpoint}/v1/${lane}`, { method: "POST", headers, body: JSON.stringify(body) });
  const environment = `<environment_context><cwd>${root}</cwd><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></environment_context>`;
  const initial = [environment, "Run one command and finish."].map(text => ({
    type: "message", role: "user", content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: "manual-http-turn" },
  }));
  const body: Event = lane === "responses" ? {
    model: "chatgpt-web/zero-risk-pro", stream: true, input: initial,
    tools: [{ type: "function", name: "exec_command", description: "Run command", parameters: { type: "object" } }],
    prompt_cache_key: "manual-http-thread",
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "manual-http-thread", turn_id: "manual-http-turn" }) },
  } : {
    model: "chatgpt-web/zero-risk-pro", stream: true, max_tokens: 64,
    system: `You are Claude Code.\n- Primary working directory: ${root}`,
    tools: [{ name: "exec_command", description: "Run command", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "Run one command and finish." }],
  };
  try {
    const first = await capture(await post(body), lane);
    if (lane === "responses") {
      const calls = first.at(-1)!.response.output.filter((item: Event) => item.type === "function_call");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("exec_command");
      expect(JSON.parse(calls[0].arguments)).toEqual({ cmd: "echo manual-http-ok" });
      body.input = [...initial, calls[0], { type: "function_call_output", call_id: calls[0].call_id, output: "manual-http-ok" }];
    } else {
      const calls = first.filter(event => event.type === "content_block_start" && event.content_block.type === "tool_use");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.content_block.name).toBe("exec_command");
      expect(first.filter(event => event.type === "message_delta").map(event => event.delta.stop_reason)).toEqual(["tool_use"]);
      const input = JSON.parse(first.filter(event => event.type === "content_block_delta" && event.delta.type === "input_json_delta")
        .map(event => event.delta.partial_json).join(""));
      expect(input).toEqual({ cmd: "echo manual-http-ok" });
      const call = { ...calls[0]!.content_block, input };
      body.messages.push({ role: "assistant", content: [call] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "manual-http-ok" }] });
    }
    const final = await capture(await post(body), lane);
    await actor;
    if (lane === "responses") {
      expect(final.at(-1)!.response.output).toMatchObject([
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "MANUAL_HTTP_OK" }] },
      ]);
      expect(final.at(-1)!.response.output).toHaveLength(1);
    } else {
      expect(final.filter(event => event.type === "content_block_start").map(event => event.content_block.type)).toEqual(["text"]);
      expect(final.filter(event => event.type === "content_block_delta").map(event => event.delta.text).join("")).toBe("MANUAL_HTTP_OK");
      expect(final.filter(event => event.type === "message_delta").map(event => event.delta.stop_reason)).toEqual(["end_turn"]);
    }
    expect(actions).toEqual(["prompt-ready", "sent", "mcp-start", "tool-result", "completed"]);
    const health = await fetch(`${endpoint}/healthz`).then(response => response.json());
    expect(health).toMatchObject({ active_http_turns: 0, active_browser_turns: 0 });
    expect(chatGptTurnSessions.activeCount()).toBe(0);
    expect(() => broker.startSafeTurn(requestId)).toThrow(/revoked|invalid/);
  } finally {
    chatGptTurnSessions.clear();
    await server.stop(true);
    await broker.close();
    await actor?.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
