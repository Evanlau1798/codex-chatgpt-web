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
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSession,
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

function provider(useNewCompactMode: boolean): CodexProviderConfig {
  return {
    adapter: "chatgpt-web",
    baseUrl: `browser://compact-mode-${useNewCompactMode}`,
    chatgptWeb: {
      localToolsEnabled: false,
      solAvailable: true,
      proAvailable: true,
      useNewCompactMode,
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

  test("fails closed instead of opening the original compact path when beta handoff is unavailable", async () => {
    const adapter = createChatGptWebAdapter(provider(true));
    const events: AdapterEvent[] = [];

    try {
      await adapter.runTurn!(compactRequest(), { headers: new Headers() }, event => events.push(event));
      throw new Error("expected beta compact handoff to fail");
    } catch (error) {
      expect(error).toMatchObject({
        status: 409,
        code: "compaction_handoff_unavailable",
        retryable: false,
      });
    }
    expect(events).toEqual([]);
  });

  test("does not attach beta handoff behavior to original-mode browser turns", async () => {
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
      expect(browserTurn?.retryPromptForAnswer).toBeUndefined();
      expect(browserTurn?.retryPromptForError).toBeUndefined();
    } finally {
      worker.run = originalRun;
    }
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

  test("routes a beta compact request through the matching active session", async () => {
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
