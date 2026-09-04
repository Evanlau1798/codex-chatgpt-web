import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatGptWebAdapter, type ChatGptZeroRiskManualControl } from "../src/adapters/chatgpt-web/index";
import { canonicalizeCompactionHandoff, cancelAllStructuredCompactions } from "../src/adapters/chatgpt-web/compaction-handoff";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { deferred } from "../src/adapters/chatgpt-web/runtime-lifecycle";
import { defaultBrokerEndpoint } from "../src/config";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

function fixture() {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-manual-compact-"));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  const environment = `<environment_context><cwd>${root}</cwd><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></environment_context>`;
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, stream: true, options: { reasoning: "low" },
    _compactionRequest: true,
    context: { tools: [], messages: [
      { role: "developer", content: environment, timestamp: 1 },
      { role: "user", content: "Keep the latest task intact.", timestamp: 2 },
    ] },
    _rawBody: {
      prompt_cache_key: root,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: root, turn_id: "compact" }) },
      input: [environment, "Keep the latest task intact."].map(text => ({ type: "message", role: "user",
        content: [{ type: "input_text", text }], internal_chat_message_metadata_passthrough: { turn_id: "compact" } })),
    },
  };
  let requestId = "";
  let starts = 0;
  const started = deferred<void>();
  const ended: string[] = [];
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) {
      starts++;
      requestId = JSON.parse(activity.prompt.match(/<codex_zero_risk_request_json>\n([^\n]+)/)![1]!).request_id;
    },
    async waitSent() {},
    waitTerminal() { broker.startSafeTurn(requestId); return new Promise<never>(() => {}); },
    async markStarted() { started.resolve(); },
    async end(_path, activity) { ended.push(activity.status); }, async cancel() {},
  };
  const adapter = createChatGptWebAdapter({ adapter: "chatgpt-web", baseUrl: `manual://${root}`,
    chatgptWeb: { browserInteractionMode: "manual", browserHost: "launcher", localToolsEnabled: true,
      browserHostDescriptorPath: join(root, "launcher.json"), brokerSocketPath: socket } },
  { broker, zeroRiskManualControl: control, worker: { run: async () => { throw new Error("No Automatic compaction worker"); } } });
  return {
    parsed, started: started.promise, ended, starts: () => starts,
    complete: (answer: string) => broker.completeSafeTurn(requestId, answer),
    run: (events: AdapterEvent[], signal?: AbortSignal) => adapter.runTurn!(parsed,
      { headers: new Headers(), abortSignal: signal }, event => events.push(event)),
    async close() {
      chatGptTurnSessions.clear();
      await cancelAllStructuredCompactions(new Error("test cleanup"));
      await broker.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const canonicalMarker of [false, true]) test(`manual compaction normalizes trailing whitespace before emission (marker: ${canonicalMarker})`, async () => {
  const testCase = fixture();
  const events: AdapterEvent[] = [];
  const running = testCase.run(events);
  void running.catch(() => {});
  try {
    await testCase.started;
    const canonical = canonicalizeCompactionHandoff(testCase.parsed, "A complete checkpoint summary.")!;
    testCase.complete((canonicalMarker ? canonical : "A complete checkpoint summary.") + " \n");
    await running;
    expect(events.filter(event => event.type === "text_delta").map(event => event.type === "text_delta" ? event.text : "").join(""))
      .toBe(canonical);
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  } finally { await testCase.close(); }
});
