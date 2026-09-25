import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { EnhancedRecoveryCheckpointStore } from "../src/adapters/chatgpt-web/enhanced-recovery-checkpoint";
import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { callTurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

test("a fresh Enhanced page receives the durable checkpoint plus its canonical tail", async () => {
  const socketPath = defaultBrokerEndpoint(join(tmpdir(), `cgw-checkpoint-${process.pid}-${Date.now()}`));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web", baseUrl: "browser://checkpoint-integration",
    chatgptWeb: {
      brokerSocketPath: socketPath, localToolsEnabled: true, solAvailable: true,
      proAvailable: true, useEnhancedWebSessionMode: true, experimentalNoAutoCompact: true,
    },
  };
  const environment = `<environment_context><cwd>${process.cwd()}</cwd><filesystem><workspace_roots><root>${process.cwd()}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`;
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID, stream: true, options: { reasoning: "high" },
    _canonicalContextComplete: true,
    context: {
      tools: [{ name: "exec_command", description: "Run", parameters: { type: "object" } }],
      messages: [
        { role: "user", content: environment, timestamp: 1 },
        { role: "user", content: "Inspect the workspace", timestamp: 2 },
        { role: "assistant", content: [{ type: "toolCall", id: "call_done", name: "exec_command", arguments: { cmd: "inspect" } }], timestamp: 3 },
        { role: "toolResult", toolCallId: "call_done", toolName: "exec_command", content: "verified result", isError: false, timestamp: 4 },
        { role: "assistant", content: [{ type: "text", text: "Continue after the checkpoint" }], timestamp: 5 },
      ],
    },
    _rawBody: {
      prompt_cache_key: "thread_checkpoint_integration",
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_checkpoint_integration", turn_id: "turn_checkpoint_integration" }) },
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: environment }], internal_chat_message_metadata_passthrough: { turn_id: "turn_checkpoint_integration" } },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the workspace" }], internal_chat_message_metadata_passthrough: { turn_id: "turn_checkpoint_integration" } },
        { type: "function_call", call_id: "call_done", name: "exec_command", arguments: '{"cmd":"inspect"}' },
        { type: "function_call_output", call_id: "call_done", output: "verified result" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Continue after the checkpoint" }] },
      ],
    },
  };
  const store = new EnhancedRecoveryCheckpointStore();
  store.commit(parsed, "Checkpoint: inspection completed; continue the user task.");
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let prepared = "";
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    const prompt = await turn.prepare();
    prepared = prompt.modelInputText ?? prompt.text;
    prompt.release();
    const answer = "Continued from checkpoint.";
    turn.onTextDelta(answer);
    return answer;
  };
  try {
    const events: AdapterEvent[] = [];
    await createChatGptWebAdapter(provider, { enhancedRecoveryCheckpointStore: store })
      .runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
    expect(prepared).toContain("Checkpoint: inspection completed");
    expect(prepared).toContain("<environment_context>");
    expect(prepared).toContain("Continue after the checkpoint");
    expect(prepared).not.toContain("verified result");
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await TurnBroker.forSocket(socketPath).close();
  }
});

for (const profile of ["Pro", "Plus", "Luna"] as const) test(`${profile} uses only its applicable recovery checkpoint`, async () => {
  const proAvailable = profile === "Pro";
  const luna = profile === "Luna";
  const socketPath = defaultBrokerEndpoint(join(tmpdir(), `cgw-checkpoint-tool-${profile}-${process.pid}-${Date.now()}`));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web", baseUrl: "browser://checkpoint-tool",
    chatgptWeb: {
      brokerSocketPath: socketPath, localToolsEnabled: true, solAvailable: !luna,
      proAvailable, useEnhancedWebSessionMode: true, experimentalNoAutoCompact: true,
    },
  };
  const environment = `<environment_context><cwd>${process.cwd()}</cwd><filesystem><workspace_roots><root>${process.cwd()}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`;
  const parsed: CodexParsedRequest = {
    modelId: luna ? CHATGPT_WEB_LUNA_MODEL_ID : CHATGPT_WEB_MODEL_ID,
    stream: true, options: { reasoning: luna ? "low" : "high" },
    context: {
      tools: [{ name: "exec_command", description: "Run", parameters: { type: "object" } }],
      messages: [
        { role: "user", content: environment, timestamp: 1 },
        { role: "user", content: "Inspect the project", timestamp: 2 },
      ],
    },
    _rawBody: {
      prompt_cache_key: "thread_passive_tool",
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_passive_tool", turn_id: "turn_passive_tool" }) },
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: environment }], internal_chat_message_metadata_passthrough: { turn_id: "turn_passive_tool" } },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the project" }], internal_chat_message_metadata_passthrough: { turn_id: "turn_passive_tool" } },
      ],
    },
  };
  class ThresholdStore extends EnhancedRecoveryCheckpointStore {
    saved?: string;
    limit?: number;
    override shouldCheckpoint(_request: CodexParsedRequest, limit: number): boolean { this.limit = limit; return true; }
    override commit(_request: CodexParsedRequest, summary: string): void { this.saved = summary; }
  }
  const store = new ThresholdStore();
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let starts = 0;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    starts += 1;
    const prompt = await turn.prepare();
    prompt.release();
    const token = prompt.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
    if (!token) throw new Error("work token missing");
    turn.onSubmitted?.();
    const claim = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const resultPromise = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke", bindingId: claim.bindingId, wireName: "exec_command", arguments: { cmd: "inspect" },
    }, 10_000);
    const progress = turn.externalProgress!;
    let snapshot = progress.snapshot();
    while (snapshot.lastToolBatchRevision === 0) snapshot = await progress.waitForChange(snapshot.revision, turn.abortSignal);
    await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
    const result = await resultPromise;
    const text = result.content.flatMap(item => typeof item === "object" && item !== null && "text" in item
      ? [String(item.text)] : []).join("\n");
    expect(text).toContain("canonical tool result");
    if (luna) {
      expect(text).not.toContain("codex.control.recovery_checkpoint");
    } else {
      expect(text).toContain("codex.control.recovery_checkpoint");
      const control = text.match(/turn_token (control_[A-Za-z0-9_-]+)/)?.[1];
      const handoffId = text.match(/"handoff_id":"(handoff_[A-Za-z0-9_-]+)"/)?.[1];
      if (!control || !handoffId) throw new Error("recovery checkpoint binding missing");
      await callTurnBroker(socketPath, {
        method: "submit_recovery_checkpoint", token: control, handoffId,
        summary: "Checkpoint: inspection complete; continue task.",
      });
    }
    const answer = "Continued in the same Web response.";
    turn.onTextDelta(answer);
    return answer;
  };
  try {
    const adapter = createChatGptWebAdapter(provider, { enhancedRecoveryCheckpointStore: store });
    const firstEvents: AdapterEvent[] = [];
    await adapter.runTurn!(parsed, { headers: new Headers() }, event => firstEvents.push(event));
    const call = firstEvents.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start");
    expect(call?.name).toBe("exec_command");
    const continuation = structuredClone(parsed);
    continuation._canonicalContextComplete = true;
    continuation.context.messages.push(
      { role: "assistant", content: [{ type: "toolCall", id: call!.id, name: "exec_command", arguments: { cmd: "inspect" } }], timestamp: 3 },
      { role: "toolResult", toolCallId: call!.id, toolName: "exec_command", content: "canonical tool result", isError: false, timestamp: 4 },
    );
    const finalEvents: AdapterEvent[] = [];
    await adapter.runTurn!(continuation, { headers: new Headers() }, event => finalEvents.push(event));
    expect(store.saved).toBe(luna ? undefined : "Checkpoint: inspection complete; continue task.");
    expect(store.limit).toBe(luna ? undefined : proAvailable ? 100_000 : 80_000);
    expect(starts).toBe(1);
    expect(finalEvents.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await TurnBroker.forSocket(socketPath).close();
  }
});
