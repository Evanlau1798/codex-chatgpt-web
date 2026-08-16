import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import {
  COMPACTION_HANDOFF_MARKER,
  createActiveCompactionHandoffPrompts,
  requestActiveCompactionHandoff,
} from "../src/adapters/chatgpt-web/compaction-handoff";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { bindClaudeSessionAbort, claudeBrowserTurnOptions, normalizeClaudeToolRequests } from "../src/adapters/chatgpt-web/claude-subagent";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSession,
  ChatGptTurnSessions,
  chatGptCompactionSourceExecutionKey,
  chatGptTurnSessions,
} from "../src/adapters/chatgpt-web/turn-execution";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
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

  test("obtains the beta checkpoint from the active tools conversation", async () => {
    let completeBrowser!: (answer: string) => void;
    const browser = new Promise<string>(resolve => { completeBrowser = resolve; });
    const text = new ChatGptTextFeed();
    const session = new ChatGptTurnSession({
      mode: "tools",
      token: Promise.resolve("turn_beta_test"),
      browser,
      trace: new ChatGptTraceFeed(),
      text,
      usageInput: compactRequest(),
      cancel: () => {},
    });
    const answer = `${COMPACTION_HANDOFF_MARKER}\nThe repository state and next action were preserved.`;
    const broker = {
      completeTool: () => {},
      requestHandoff: () => {
        text.push(answer);
        completeBrowser(answer);
      },
    };

    await expect(requestActiveCompactionHandoff(
      compactRequest(),
      session,
      broker as never,
    )).resolves.toBe("The repository state and next action were preserved.");
  });

  test("does not claim a queued active handoff instruction was delivered", async () => {
    let completeBrowser!: (answer: string) => void;
    const browser = new Promise<string>(resolve => { completeBrowser = resolve; });
    const text = new ChatGptTextFeed();
    const answer = `${COMPACTION_HANDOFF_MARKER}\nThe queued handoff used the full same-conversation prompt.`;
    let instructionDelivered: boolean | undefined;
    const session = new ChatGptTurnSession({
      mode: "tools",
      token: Promise.resolve("turn_queued_handoff"),
      browser,
      trace: new ChatGptTraceFeed(),
      text,
      usageInput: compactRequest(),
      requestHandoff: delivered => {
        instructionDelivered = delivered;
        text.push(answer);
        completeBrowser(answer);
      },
      cancel: () => {},
    });
    const broker = {
      completeTool: () => {},
      requestHandoff: () => "queued" as const,
    };

    await expect(requestActiveCompactionHandoff(
      compactRequest(),
      session,
      broker as never,
    )).resolves.toBe("The queued handoff used the full same-conversation prompt.");
    expect(instructionDelivered).toBe(false);
  });

  test("requests the beta checkpoint from the active read-only conversation", async () => {
    let completeBrowser!: (answer: string) => void;
    const browser = new Promise<string>(resolve => { completeBrowser = resolve; });
    const answer = `${COMPACTION_HANDOFF_MARKER}\nThe Pro conversation preserved its active state.`;
    let requested = false;
    const session = new ChatGptTurnSession({
      mode: "read-only",
      browser,
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      usageInput: compactRequest(),
      requestHandoff: () => {
        requested = true;
        completeBrowser(answer);
      },
      cancel: () => {},
    });

    await expect(requestActiveCompactionHandoff(
      compactRequest(),
      session,
      {} as TurnBroker,
    )).resolves.toBe("The Pro conversation preserved its active state.");
    expect(requested).toBe(true);
  });

  test("extends the handoff idle deadline while the streamed block keeps growing", async () => {
    let completeBrowser!: (answer: string) => void;
    const browser = new Promise<string>(resolve => { completeBrowser = resolve; });
    const text = new ChatGptTextFeed();
    const answer = `${COMPACTION_HANDOFF_MARKER}\nThe adaptive checkpoint kept growing until complete.`;
    const session = new ChatGptTurnSession({
      mode: "read-only",
      browser,
      trace: new ChatGptTraceFeed(),
      text,
      usageInput: compactRequest(),
      requestHandoff: () => {
        setTimeout(() => text.push(`${COMPACTION_HANDOFF_MARKER}\nThe adaptive checkpoint`), 10);
        setTimeout(() => text.push(" kept growing"), 30);
        setTimeout(() => {
          text.push(" until complete.");
          completeBrowser(answer);
        }, 50);
      },
      cancel: () => {},
    });

    await expect(requestActiveCompactionHandoff(
      compactRequest(),
      session,
      {} as TurnBroker,
      undefined,
      5,
      30,
      2,
    )).resolves.toBe("The adaptive checkpoint kept growing until complete.");
  });

  test("recovers a valid handoff after it becomes idle when the browser outcome never settles", async () => {
    const text = new ChatGptTextFeed();
    const answer = `${COMPACTION_HANDOFF_MARKER}\nThe streamed checkpoint is safe to resume.`;
    const session = new ChatGptTurnSession({
      mode: "read-only",
      browser: new Promise<string>(() => {}),
      trace: new ChatGptTraceFeed(),
      text,
      usageInput: compactRequest(),
      requestHandoff: () => setTimeout(() => text.push(answer), 20),
      cancel: () => {},
    });

    await expect(requestActiveCompactionHandoff(
      compactRequest(),
      session,
      {} as TurnBroker,
      undefined,
      5,
      30,
    )).resolves.toBe("The streamed checkpoint is safe to resume.");
  });

  test("retries malformed and recoverable handoff responses in the same conversation", () => {
    const prompts = createActiveCompactionHandoffPrompts();
    expect(prompts.retryPromptForAnswer("ordinary answer")).toBeUndefined();

    prompts.request(false);
    expect(prompts.retryPromptForAnswer("ordinary answer")).toContain("Automatic Codex context compaction");
    expect(prompts.retryPromptForAnswer("malformed checkpoint")).toContain("checkpoint response was rejected");
    expect(prompts.retryPromptForError(new Error("ChatGPT completed text block changed"))).toContain(
      "Automatic Codex context compaction",
    );
    expect(prompts.retryPromptForAnswer("still malformed")).toBeUndefined();
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
      cancel: () => broker.revoke(token),
    });
    const namespace = createHash("sha256").update(JSON.stringify({
      baseUrl: config.baseUrl,
      chatgptWeb: config.chatgptWeb,
    })).digest("hex");
    const sessionKey = `${namespace}:${chatGptCompactionSourceExecutionKey(request)}`;
    chatGptTurnSessions.getOrCreate(sessionKey, () => session.runtime);
    const answer = `${COMPACTION_HANDOFF_MARKER}\nThe active Web Agent preserved the implementation state.`;
    const complete = setInterval(() => {
      if (!broker.handoffRequested(token)) return;
      clearInterval(complete);
      text.push(answer);
      completeBrowser(answer);
    }, 1);
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
      clearInterval(complete);
      await chatGptTurnSessions.retireAndWait(sessionKey);
      await broker.close();
    }
  });

});
