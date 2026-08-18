import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import {
  createActiveCompactionHandoffPrompts,
} from "../src/adapters/chatgpt-web/compaction-handoff";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { runEnhancedCompaction } from "../src/adapters/chatgpt-web/enhanced-compaction";
import { bindClaudeSessionAbort, claudeBrowserTurnOptions, normalizeClaudeToolRequests } from "../src/adapters/chatgpt-web/claude-subagent";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSession,
  ChatGptTurnSessions,
  chatGptCompactionSourceExecutionKey,
  chatGptTurnSessions,
} from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { buildResponseJSON } from "../src/bridge";
import { defaultBrokerEndpoint } from "../src/config";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

function compactRequest(): CodexParsedRequest {
  const turnId = "turn_compact_source";
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    context: {
      messages: [{ role: "user", content: "Inspect the project", timestamp: 1 }],
    },
    options: { reasoning: "high" },
    _compactionRequest: true,
    _rawBody: {
      prompt_cache_key: "thread_compact_test",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_compact_test",
          turn_id: "turn_compact_request",
        }),
      },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Inspect the project" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }],
    },
  };
}

function provider(useEnhancedWebSessionMode: boolean): CodexProviderConfig {
  return {
    adapter: "chatgpt-web",
    baseUrl: `browser://enhanced-session-${useEnhancedWebSessionMode}`,
    chatgptWeb: {
      localToolsEnabled: false,
      solAvailable: true,
      proAvailable: true,
      useEnhancedWebSessionMode,
    },
  };
}

describe("compact mode routing", () => {
  test("keeps the original compact serializer opaque to handoff-specific validation", () => {
    const response = buildResponseJSON([
      {
        type: "text_delta",
        text: "I cannot produce a checkpoint summary because context is not available.",
        phase: "final_answer",
      },
      { type: "done", stopReason: "stop", endTurn: true },
    ], CHATGPT_WEB_MODEL_ID, { compaction: true }) as {
      status: string;
      output: Array<{ type: string }>;
    };

    expect(response.status).toBe("completed");
    expect(response.output[0]?.type).toBe("compaction");
  });

  test("fails closed instead of opening the original compact path when enhanced handoff is unavailable", async () => {
    const adapter = createChatGptWebAdapter(provider(true));
    const events: AdapterEvent[] = [];

    try {
      await adapter.runTurn!(compactRequest(), { headers: new Headers() }, event => events.push(event));
      throw new Error("expected enhanced compact handoff to fail");
    } catch (error) {
      expect(error).toMatchObject({
        status: 409,
        code: "compaction_handoff_unavailable",
        retryable: false,
      });
    }
    expect(events).toEqual([]);
  });

  test("rebuilds a fresh Web compact turn when the enhanced source session was lost", async () => {
    const config = provider(true);
    config.baseUrl = `browser://enhanced-compact-rebuild-${process.pid}-${Date.now()}`;
    config.chatgptWeb!.localToolsEnabled = true;
    const worker = ChatGptBrowserWorker.forProvider(config);
    const originalRun = worker.run.bind(worker);
    const summary = "Checkpoint summary rebuilt from the complete supplied Codex task context.";
    let browserTurn: BrowserTurn | undefined;
    let preparedText = "";
    worker.run = async turn => {
      browserTurn = turn;
      const prepared = await turn.prepare();
      preparedText = prepared.text;
      prepared.release();
      turn.onTextDelta(summary);
      return summary;
    };
    const events: AdapterEvent[] = [];

    try {
      await createChatGptWebAdapter(config).runTurn!(
        compactRequest(),
        { headers: new Headers() },
        event => events.push(event),
      );

      expect(browserTurn).toBeDefined();
      expect(browserTurn?.requireRetainedConversation).toBeUndefined();
      expect(browserTurn?.nativeConnector).toBe(true);
      expect(preparedText).toContain("This is a Codex history-compaction checkpoint");
      expect(preparedText).toContain("Inspect the project");
      expect(events.some(event => event.type === "text_delta" && event.text === summary)).toBe(true);
      expect(events.some(event => event.type === "text_delta"
        && event.text.includes("CODEX_LATEST_USER_PROMPT_JSON"))).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    } finally {
      worker.run = originalRun;
    }
  });

  test("rebuilds when the retained source session outlives its browser conversation", async () => {
    const sourceRequest = compactRequest();
    delete sourceRequest._compactionRequest;
    const parsed = compactRequest();
    const socketPath = defaultBrokerEndpoint(join(
      tmpdir(),
      `compact-source-preserved-${process.pid}-${Date.now()}`,
    ));
    const broker = TurnBroker.forSocket(socketPath);
    const responseExecutionKey = `preserved-source-${process.pid}-${Date.now()}`;
    let cancelled = 0;
    let released = 0;
    const source = chatGptTurnSessions.getOrCreate(responseExecutionKey, () => ({
      mode: "read-only",
      browser: Promise.resolve("source completed"),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      usageInput: sourceRequest,
      conversationKey: createHash("sha256").update("preserved-source-conversation").digest("hex"),
      cancel: () => { cancelled += 1; },
      release: async () => { released += 1; },
    }));
    await source.browserOutcome;
    const worker = {
      run: async () => { throw new Error("The retained ChatGPT conversation is no longer available"); },
    };

    try {
      await expect(runEnhancedCompaction({
        worker: worker as never,
        parsed,
        broker,
        executionNamespace: createHash("sha256").update("preserved-source-namespace").digest("hex"),
        capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
        responseExecutionKey,
        nativeConnectorAvailable: true,
        timeoutMs: 20,
        emit: () => {},
      })).resolves.toBe("rebuild");

      expect(chatGptTurnSessions.find(responseExecutionKey)).toBeUndefined();
      expect(cancelled).toBe(1);
      expect(released).toBe(1);
    } finally {
      await chatGptTurnSessions.retireAndWait(responseExecutionKey);
      await broker.close();
    }
  });

  test("does not attach enhanced handoff behavior to original-mode browser turns", async () => {
    const config = provider(false);
    const worker = ChatGptBrowserWorker.forProvider(config);
    const originalRun = worker.run.bind(worker);
    let browserTurn: BrowserTurn | undefined;
    worker.run = turn => {
      browserTurn = turn;
      turn.onTextDelta("original response");
      return Promise.resolve("original response");
    };
    const request = compactRequest();
    delete request._compactionRequest;
    const metadata = (request._rawBody as { client_metadata: Record<string, string> }).client_metadata;
    metadata["x-codex-turn-metadata"] = JSON.stringify({
      thread_id: "thread_compact_test",
      turn_id: "turn_compact_source",
    });

    try {
      await createChatGptWebAdapter(config).runTurn!(request, { headers: new Headers() }, () => {});
      expect(browserTurn?.retryPromptForAnswer?.("ordinary answer", 1)).toBeUndefined();
      expect(browserTurn?.retryPromptForError).toBeUndefined();
      expect(browserTurn?.retainConversation).toBeUndefined();
      expect(browserTurn?.conversationKey).toBeUndefined();
      expect(browserTurn?.prepareResume).toBeUndefined();
    } finally {
      worker.run = originalRun;
    }
  });

  test("retries incomplete subagent answers without retaining its browser tab", async () => {
    const config = provider(false);
    const worker = ChatGptBrowserWorker.forProvider(config);
    const originalRun = worker.run.bind(worker);
    let browserTurn: BrowserTurn | undefined;
    worker.run = turn => {
      browserTurn = turn;
      turn.onTextDelta("No findings.");
      return Promise.resolve("No findings.");
    };
    const request = compactRequest();
    delete request._compactionRequest;
    request.context.tools = [{ name: "PowerShell", description: "Run a command", parameters: {} }];
    const rawBody = request._rawBody as {
      client_metadata: Record<string, unknown>;
      input: Array<{ internal_chat_message_metadata_passthrough?: { turn_id?: string } }>;
      prompt_cache_key: string;
    };
    rawBody.prompt_cache_key = "thread_subagent_progress";
    rawBody.input[0]!.internal_chat_message_metadata_passthrough = { turn_id: "turn_subagent_progress" };
    const metadata = rawBody.client_metadata;
    metadata["x-codex-turn-metadata"] = JSON.stringify({
      thread_id: "thread_subagent_progress",
      turn_id: "turn_subagent_progress",
    });
    metadata.claude_subagent = true;
    metadata.claude_retain_conversation = false;
    let toolResultDelivered = false;

    try {
      await createChatGptWebAdapter(config).runTurn!(request, { headers: new Headers() }, () => {});
      expect(browserTurn?.retainConversation).toBeUndefined();
      expect(browserTurn?.retryPromptForAnswer?.("Gathering test_deploy_artifacts.py diff", 1)).toContain(
        "only a progress update",
      );
      expect(() => browserTurn?.retryPromptForAnswer?.("Gathering the same diff", 2)).toThrow(
        "subagent completed with only a progress update",
      );
      const retry = claudeBrowserTurnOptions(request, undefined, {
        toolResultDelivered: () => toolResultDelivered,
        turnToken: () => "current-retry-token",
      }).retryPromptForAnswer;
      const refusedRetry = retry?.(
        "無法執行 git status：目前這個 Codex turn 沒有提供可用的原生命令執行工具。",
        1,
      );
      expect(refusedRetry).toContain("Advertised client tools are available");
      expect(refusedRetry).toContain("PowerShell");
      expect(refusedRetry).toContain("codex_tool_inventory");
      expect(refusedRetry).toContain('query "PowerShell"');
      expect(refusedRetry).toContain("invoke the returned wire_name");
      expect(refusedRetry).toContain("Do not answer before the tool call returns");
      expect(refusedRetry).toContain("turn_token current-retry-token");
      expect(retry?.(
        "這個回合沒有可用的 PowerShell 執行結果，因此不能執行請求。",
        1,
      )).toContain("codex_tool_inventory");
      expect(retry?.(
        "The native shell gateway is unavailable, so I could not run the command.",
        1,
      )).toContain("Advertised client tools are available");
      expect(retry?.(
        "This Codex turn did not advertise a native command tool or the native exec gateway",
        1,
      )).toContain("Advertised client tools are available");
      expect(retry?.(
        "其執行環境未提供 command/exec gateway，因此沒有實際輸出。",
        1,
      )).toContain("Advertised client tools are available");
      expect(retry?.(
        "I was not able to complete the inspection in the provided workspace from the available execution environment.",
        1,
      )).toContain("Advertised client tools are available");
      expect(retry?.(
        "The deployment action did not execute because approval was not requested.",
        1,
      )).toBeUndefined();
      expect(retry?.(
        "The native Read tool invocation was blocked by OpenAI safety checks.",
        1,
      )).toBeUndefined();
      expect(retry?.(
        "The read-only inspection action did not execute, so I do not have a native tool result to report.",
        1,
      )).toContain("Advertised client tools are available");
      expect(retry?.(
        "The Codex Native2 invocation tool is not exposed in this turn.",
        1,
      )).toContain("Advertised client tools are available");
      expect(retry?.(
        "重試後仍未提供 native command/exec 工具。",
        2,
      )).toBeUndefined();
      expect(retry?.(
        "我目前這個回合可用的工具介面中沒有 codex_tool_inventory 或 codex_tool_call。",
        2,
      )).toBeUndefined();
      request.context.messages.push({
        role: "toolResult",
        toolCallId: "call_failed",
        toolName: "PowerShell",
        content: "Codex Native connection timed out",
        isError: true,
        timestamp: Date.now(),
      });
      toolResultDelivered = true;
      expect(retry?.(
        "The native shell gateway is unavailable, so I could not run the command.",
        1,
      )).toBeUndefined();
      expect(browserTurn?.retryPromptForAnswer?.("No findings.", 1)).toBeUndefined();
    } finally {
      worker.run = originalRun;
    }
  });

  test("does not inject a hidden tool-recovery turn after a Claude root answer", () => {
    const request = compactRequest();
    delete request._compactionRequest;
    request.context.tools = [
      { name: "Read", description: "Read a file", parameters: {} },
      { name: "Glob", description: "Find files", parameters: {} },
      { name: "Task", description: "Run a subagent", parameters: {} },
    ];
    const metadata = (request._rawBody as { client_metadata: Record<string, unknown> }).client_metadata;
    metadata.claude_subagent = false;

    const retry = claudeBrowserTurnOptions(request).retryPromptForAnswer;
    expect(retry?.(
      "This Codex turn did not advertise a native command tool or the native exec gateway",
      1,
    )).toBeUndefined();
    expect(retry?.(
      "Task is unavailable in this turn.",
      1,
    )).toBeUndefined();
    expect(retry?.("Gathering repository context", 1)).toBeUndefined();
    expect(retry?.("The native shell gateway is unavailable", 2)).toBeUndefined();
  });

  test("forces Claude Agent dispatches into the background", () => {
    const request = compactRequest();
    const metadata = (request._rawBody as { client_metadata: Record<string, unknown> }).client_metadata;
    metadata.claude_subagent = false;
    const tools = [
      { callId: "call_agent", wireName: "Agent", freeform: false, arguments: { run_in_background: false } },
      { callId: "call_shell", wireName: "PowerShell", freeform: false, arguments: { command: "Get-Location" } },
    ];

    normalizeClaudeToolRequests(request, tools);

    expect(tools[0]!.arguments).toEqual({ run_in_background: true });
    expect(tools[1]!.arguments).toEqual({ command: "Get-Location" });
  });

  test("aborting a Claude round retires every browser turn in the same session", () => {
    const request = compactRequest();
    const metadata = (request._rawBody as { client_metadata: Record<string, unknown> }).client_metadata;
    metadata.claude_subagent = true;
    const sessions = new ChatGptTurnSessions();
    let cancelled = 0;
    const runtime = () => ({
      mode: "read-only" as const,
      browser: new Promise<string>(() => {}),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => { cancelled += 1; },
    });
    sessions.getOrCreate("parent", runtime, "thread_compact_test");
    sessions.getOrCreate("child", runtime, "thread_compact_test");
    sessions.getOrCreate("unrelated", runtime, "another_claude_session");
    const abort = new AbortController();
    const unbind = bindClaudeSessionAbort(request, abort.signal, sessions);

    abort.abort();
    unbind();

    expect(cancelled).toBe(2);
    expect(sessions.activeCount()).toBe(1);
    expect(sessions.find("unrelated")).toBeDefined();
    sessions.clear();
  });

  test("delivers a structured active checkpoint instruction only once in the same conversation", () => {
    const prompts = createActiveCompactionHandoffPrompts();
    expect(prompts.retryPromptForAnswer("ordinary answer")).toBeUndefined();

    prompts.request("structured control instruction", false);
    expect(prompts.retryPromptForAnswer("ordinary answer")).toBe("structured control instruction");
    expect(prompts.retryPromptForAnswer("another answer")).toBeUndefined();
    expect(prompts.retryPromptForError(new Error("ChatGPT completed text block changed"))).toBeUndefined();
  });

  test("routes an enhanced compact request through the matching active session", async () => {
    const request = compactRequest();
    const socketPath = defaultBrokerEndpoint(join(
      tmpdir(),
      `compact-mode-routing-${process.pid}-${Date.now()}`,
    ));
    const config = provider(true);
    config.chatgptWeb!.brokerSocketPath = socketPath;
    config.chatgptWeb!.localToolsEnabled = true;
    const broker = TurnBroker.forSocket(socketPath);
    const token = await broker.register({
      cwd: process.cwd(),
      roots: [process.cwd()],
      writableRoots: [process.cwd()],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
    let completeBrowser!: (answer: string) => void;
    const browser = new Promise<string>(resolve => { completeBrowser = resolve; });
    const text = new ChatGptTextFeed();
    const session = new ChatGptTurnSession({
      mode: "tools",
      token: Promise.resolve(token),
      browser,
      trace: new ChatGptTraceFeed(),
      text,
      usageInput: request,
      requestHandoff: instruction => {
        const controlToken = instruction.match(/turn_token (control_[a-f0-9]{32})/)?.[1];
        const handoffId = instruction.match(/handoff_id (handoff_[a-f0-9]{32})/)?.[1];
        if (!controlToken || !handoffId) throw new Error("structured compaction binding was not supplied");
        void callTurnBroker(broker.socketPath, {
          method: "submit_compaction_handoff",
          token: controlToken,
          handoffId,
          summary: "The active Web Agent preserved the implementation state.",
        }).then(() => completeBrowser("The structured checkpoint Web response ended normally."));
      },
      cancel: () => broker.revoke(token),
    });
    const namespace = createHash("sha256").update(JSON.stringify({
      baseUrl: config.baseUrl,
      chatgptWeb: config.chatgptWeb,
    })).digest("hex");
    const sessionKey = `${namespace}:${chatGptCompactionSourceExecutionKey(request)}`;
    chatGptTurnSessions.getOrCreate(sessionKey, () => session.runtime);
    const events: AdapterEvent[] = [];

    try {
      await createChatGptWebAdapter(config).runTurn!(
        request,
        { headers: new Headers() },
        event => events.push(event),
      );
      expect(events.some(event => event.type === "text_delta"
        && event.text.includes("The active Web Agent preserved"))).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    } finally {
      await chatGptTurnSessions.retireAndWait(sessionKey);
      await broker.close();
    }
  });

});
