import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatGptWebAdapter, type ChatGptZeroRiskManualControl } from "../src/adapters/chatgpt-web/index";
import { callTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultBrokerEndpoint } from "../src/config";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

test("Zero Risk emits a real broker tool call and consumes its result without a DOM observer", async () => {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-manual-tool-"));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  const config: CodexProviderConfig = {
    adapter: "chatgpt-web", baseUrl: `manual://${root}`,
    chatgptWeb: {
      browserInteractionMode: "manual", browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"), brokerSocketPath: socket,
      localToolsEnabled: true, useEnhancedWebSessionMode: true,
    },
  };
  const environment = `<environment_context><cwd>${root}</cwd><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></environment_context>`;
  const input: CodexParsedRequest = {
    modelId: CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, stream: true, options: { reasoning: "low" },
    context: {
      tools: [{ name: "exec_command", description: "Run a command", parameters: { type: "object" } }],
      messages: [
        { role: "developer", content: environment, timestamp: 1 },
        { role: "user", content: "Run one command and finish.", timestamp: 2 },
      ],
    },
    _rawBody: {
      prompt_cache_key: "manual-tool-thread",
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "manual-tool-thread", turn_id: "manual-tool-turn" }) },
      input: [environment, "Run one command and finish."].map(text => ({
        type: "message", role: "user", content: [{ type: "input_text", text }],
        internal_chat_message_metadata_passthrough: { turn_id: "manual-tool-turn" },
      })),
    },
  };
  let requestId = "";
  let starts = 0;
  let actor: Promise<void> | undefined;
  const ended: string[] = [];
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) {
      starts++;
      requestId = JSON.parse(activity.prompt.match(/<codex_zero_risk_request_json>\n([^\n]+)/)![1]!).request_id;
    },
    async waitSent() {},
    waitTerminal() { broker.startSafeTurn(requestId); return new Promise<never>(() => {}); },
    async markStarted() {
      actor = (async () => {
        const claim = await callTurnBroker<{ bindingId: string; activityId: string }>(socket, {
          method: "claim", token: requestId, contract: "safe",
        });
        const result = await callTurnBroker<BrokerToolResult>(socket, {
          method: "invoke", bindingId: claim.bindingId, wireName: "exec_command",
          freeform: false, arguments: { cmd: "echo manual-ok" },
        }, null);
        expect(result.content).toEqual([{ type: "text", text: "manual-ok" }]);
        await callTurnBroker(socket, { method: "activity_complete", token: requestId, activityId: claim.activityId });
        broker.completeSafeTurn(requestId, "MANUAL_TOOL_OK");
      })();
      void actor.catch(() => {});
    },
    async end(_path, activity) { ended.push(activity.status); },
    async cancel() {},
  };
  const adapter = createChatGptWebAdapter(config, {
    broker, zeroRiskManualControl: control,
    worker: { run: async () => { throw new Error("Manual turn must not run a DOM worker"); } },
  });
  const events: AdapterEvent[] = [];
  try {
    await adapter.runTurn!(input, { headers: new Headers() }, event => events.push(event));
    const call = events.find(event => event.type === "tool_call_start");
    expect(call).toMatchObject({ type: "tool_call_start", name: "exec_command" });
    if (!call || call.type !== "tool_call_start") throw new Error("No native tool call was emitted");
    const args = JSON.parse(events.filter(event => event.type === "tool_call_delta")
      .map(event => event.type === "tool_call_delta" ? event.arguments : "").join(""));
    expect(args).toEqual({ cmd: "echo manual-ok" });
    input.context.messages.push(
      { role: "assistant", content: [{ type: "toolCall", id: call.id, name: call.name, arguments: args }], timestamp: 3 },
      { role: "toolResult", toolCallId: call.id, toolName: call.name, content: "manual-ok", isError: false, timestamp: 4 },
    );
    const final: AdapterEvent[] = [];
    await adapter.runTurn!(input, { headers: new Headers() }, event => final.push(event));
    await actor;
    expect(final.filter(event => event.type === "text_delta" && event.phase === "final_answer")
      .map(event => event.type === "text_delta" ? event.text : "").join("")).toBe("MANUAL_TOOL_OK");
    expect(final.filter(event => event.type === "done")).toHaveLength(1);
    expect(final.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(starts).toBe(1);
    expect(ended).toEqual(["completed"]);
  } finally {
    chatGptTurnSessions.clear();
    await broker.close();
    await actor?.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
