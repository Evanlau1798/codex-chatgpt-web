import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ChatGptPromptIntegrityMismatchError, ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { chatGptPromptAttachmentMismatch } from "../src/adapters/chatgpt-web/prompt-caret";
import { ChatGptWebTurnRetryPolicy } from "../src/adapters/chatgpt-web/retry-policy";
import { chatGptPromptFailureKey } from "../src/adapters/chatgpt-web/turn-retry-identity";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { defaultConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { startServer } from "../src/server";

function body(thread: string, turn: string, item = "user-1", text = "safe synthetic task") {
  return { model: "chatgpt-web/high", stream: false, prompt_cache_key: thread,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: turn }) },
    input: [{ type: "message", id: item, role: "user", content: [{ type: "input_text", text }],
      internal_chat_message_metadata_passthrough: { turn_id: turn } }],
  };
}

const mismatch = () => chatGptPromptAttachmentMismatch("Prompt text mismatch", "private\nfixture", "private\n\nfixture") as ChatGptPromptIntegrityMismatchError;

test("terminal comparison is typed, content-free and never a transient surface retry", () => {
  const error = mismatch();
  expect(error).toBeInstanceOf(ChatGptPromptIntegrityMismatchError);
  expect(error).toMatchObject({ retryable: false, retireSession: true, code: "chatgpt_prompt_integrity_mismatch" });
  expect(error.message).not.toContain("private"); expect(error.message).not.toContain("U+");
});

test("integrity receipts are bounded, expire absolutely and survive transient retry resets", () => {
  const policy = new ChatGptWebTurnRetryPolicy(100, 2); const error = mismatch();
  policy.recordPromptIntegrityFailure("a", error, 0);
  policy.clear("a"); expect(policy.promptIntegrityFailure("a", 90)).toBe(error);
  policy.recordPromptIntegrityFailure("a", error, 99);
  expect(policy.promptIntegrityFailure("a", 100)).toBeUndefined();
  policy.recordPromptIntegrityFailure("a", error, 101);
  policy.recordPromptIntegrityFailure("b", error, 102);
  policy.recordPromptIntegrityFailure("c", error, 103);
  expect(policy.promptIntegrityFailure("a", 104)).toBeUndefined(); // documented FIFO capacity bound
  expect(policy.promptIntegrityFailure("b", 104)).toBe(error);
  policy.recordPromptIntegrityFailure("timeout", new ChatGptWebAdapterError("timeout", {
    status: 502, errorType: "server_error", code: "chatgpt_surface_changed", retryable: true,
  }), 104);
  expect(policy.promptIntegrityFailure("timeout", 104)).toBeUndefined();
});

test("failure identity distinguishes owners/revisions/results, not transport flags or timestamps", () => {
  const request = body("thread", "turn"); const first = parseRequest(request);
  const key = chatGptPromptFailureKey(first);
  const replay = parseRequest({ ...request, stream: true });
  replay.context.messages[0]!.timestamp += 1_000;
  expect(chatGptPromptFailureKey(replay)).toBe(key);
  for (const changed of [body("other-thread", "turn"), body("thread", "other-turn"),
    body("thread", "turn", "user-2"), body("thread", "turn", "user-1", "new instruction")]) {
    expect(chatGptPromptFailureKey(parseRequest(changed))).not.toBe(key);
  }
  const continuation = parseRequest(request);
  continuation.context.messages.push({ role: "toolResult", toolCallId: "call-1", toolName: "fixture", content: "new result", isError: false, timestamp: 3 });
  expect(chatGptPromptFailureKey(continuation)).not.toBe(key);
  expect(() => chatGptPromptFailureKey(parseRequest({ model: "chatgpt-web/high", input: "same text without identity" }))).toThrow();
});

test("worker fresh-surface retry and compaction retry do not multiply typed integrity attempts", async () => {
  const error = mismatch(); let starts = 0; let resets = 0;
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    runExclusive: async () => { starts += 1; throw error; },
    attachPrompt: async () => { starts += 1; throw error; },
    resetCompactionComposerForRetry: async () => { resets += 1; },
  });
  await expect(worker.runWithSurfaceRetry({ modelId: CHATGPT_WEB_MODEL_ID, reasoning: "high", capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: true } }))
    .rejects.toBe(error);
  await expect(worker.attachPromptWithCompactionRetry({}, "fixture", false, true, {})).rejects.toBe(error);
  expect(starts).toBe(2); expect(resets).toBe(0);
});

test("failed cleanup preserves terminal integrity classification while requiring surface retirement", async () => {
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    activeComposer: async () => ({ fill: async () => {}, focus: async () => {} }),
    insertPromptText: async () => { throw mismatch(); },
    clearChatGptComposerState: async () => { throw new Error("private cleanup detail"); },
  });
  const absentDialog = { filter: () => absentDialog, last: () => absentDialog, isVisible: async () => false };
  const page = { locator: () => absentDialog };
  const error = await worker.attachPrompt(page, "fixture", false).catch((error: unknown) => error);
  expect(error).toMatchObject({ code: "chatgpt_prompt_integrity_mismatch", retryable: false, retireSession: true });
  expect(error.message).toContain("cleanup could not be verified");
  expect(error.message).not.toContain("private cleanup detail");
});

test("real helper protocol handling retains terminal code across the process boundary", async () => {
  const client = new LauncherBrowserHelperClient({} as never) as any;
  const child = {}; client.child = child;
  let failure: unknown; let released = 0;
  client.pending.set("owned", { turn: {}, reject: (error: unknown) => { failure = error; },
    prepared: { release: () => { released += 1; } } });
  const error = mismatch();
  client.handleLine(child, JSON.stringify({ type: "error", id: "owned", message: error.message,
    status: error.status, errorType: error.errorType, code: error.code, retryable: error.retryable, retireSession: error.retireSession }));
  expect(failure).toBeInstanceOf(ChatGptWebAdapterError);
  expect(failure).toMatchObject({ code: error.code, retryable: false, retireSession: true });
  expect(released).toBe(1); expect(client.pending.size).toBe(0);
});

for (const path of ["/v1/responses", "/v1/responses/compact"] as const) {
  test(`production HTTP + adapter ${path} replays terminal failure without re-entering writer`, async () => {
    const config = defaultConfig("browser-only"); config.port = 0;
    config.useEnhancedWebSessionMode = false;
    const identity = randomUUID(); let writers = 0; let edits = 0; let sends = 0;
    const worker = {
      requestPreemptiveRetry: () => false,
      async run(turn: BrowserTurn): Promise<string> {
        writers += 1; const prepared = await turn.prepare(); prepared.release();
        const failedWriter = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
          runExclusive: async () => { edits += 1; throw mismatch(); },
        });
        return failedWriter.runWithSurfaceRetry({ ...turn, onSendActivated: async () => { sends += 1; } });
      },
    };
    const server = startServer(config, { adapterFactory: provider => createChatGptWebAdapter(provider, { worker }) });
    const request = body(identity, "turn-1");
    const post = async (data: ReturnType<typeof body>, stream = false) => {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...data, stream }),
      });
      const text = await response.text();
      expect(text).toContain("chatgpt_prompt_integrity_mismatch");
      expect(text).toContain('"retryable":false');
      expect(text).not.toContain("private");
      if (path === "/v1/responses" && !stream) expect(JSON.parse(text).status).toBe("failed");
      if (path === "/v1/responses" && stream) {
        expect(text.match(/event: response.failed/g)).toHaveLength(1);
        expect(text).not.toContain("event: response.completed");
      }
    };
    try {
      for (let retry = 0; retry < 6; retry += 1) await post(request, path === "/v1/responses" && retry % 2 === 1);
      expect(writers).toBe(1); expect(edits).toBe(1); expect(sends).toBe(0);
      await post(body(identity, "turn-1", "user-2", "genuine new revision"));
      expect(writers).toBe(2);
      await post(request); // an old retry arriving after the revision still has its own terminal receipt
      expect(writers).toBe(2);
      await post(body(identity, "turn-2")); expect(writers).toBe(3);
    } finally { await server.stop(true); chatGptTurnSessions.clear(); }
  });
}
