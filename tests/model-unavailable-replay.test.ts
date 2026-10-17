import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { defaultBrokerEndpoint, defaultConfig } from "../src/config";
import { join } from "node:path";
import { startServer } from "../src/server";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { ChatGptWebAdapterError, chatGptCompletionEvidenceError, chatGptModelUnavailableError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptWebTurnRetryPolicy } from "../src/adapters/chatgpt-web/retry-policy";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";

function request(thread: string, turn = "turn-1", revision = "user-1", model = "chatgpt-web/gpt-6-sol") {
  return { model, stream: true, reasoning: { effort: "high" }, prompt_cache_key: thread,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: turn }) },
    input: [{ type: "message", id: revision, role: "user", content: [{ type: "input_text", text: "safe synthetic task" }],
      internal_chat_message_metadata_passthrough: { turn_id: turn } }],
  };
}

test("model rejection receipts retain their original expiry and bounded capacity", () => {
  const policy = new ChatGptWebTurnRetryPolicy(100, 2), error = chatGptModelUnavailableError();
  policy.recordTerminalFailure("a", error, 0);
  policy.clear("a"); policy.recordTerminalFailure("a", error, 99);
  expect(policy.terminalFailure("a", 99)).toBe(error);
  expect(policy.terminalFailure("a", 100)).toBeUndefined();
  for (const [key, now] of [["a", 101], ["b", 102], ["c", 103]] as const) policy.recordTerminalFailure(key, error, now);
  expect(policy.terminalFailure("a", 104)).toBeUndefined();
  expect(policy.terminalFailure("b", 104)).toBe(error);
});

test.each([
  ["model rejection", chatGptModelUnavailableError, "model_not_found", "invalid_request_error"],
  ["exhausted final recovery", () => chatGptCompletionEvidenceError("same-surface final recovery was already attempted", true),
    "chatgpt_completion_evidence_missing", "server_error"],
] as const)("a streamed %s makes outer reconnect terminal without another browser send", async (_label, failure, code, type) => {
  const config = defaultConfig("browser-only"); config.port = 0;
  config.useEnhancedWebSessionMode = false;
  config.extraHighAvailable = true;
  let starts = 0; let sends = 0;
  const worker = { requestPreemptiveRetry: () => false, async run(turn: BrowserTurn): Promise<string> {
    starts++; const prepared = await turn.prepare(); prepared.release();
    await turn.onSendActivated?.();
    await turn.onSubmitted?.(); sends++;
    throw failure();
  } };
  const server = startServer(config, { adapterFactory: p => createChatGptWebAdapter(p, { worker }) });
  const body = request(randomUUID());
  const post = async (data: object) => {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
    });
    return { status: response.status, text: await response.text() };
  };
  try {
    const first = await post(body);
    expect(first.status).toBe(200);
    expect(first.text).toContain("event: response.failed");
    expect(first.text).toContain('"retryable":false');
    expect(first.text).toContain(code);
    for (let n = 0; n < 5; n++) {
      const replay = await post({ ...body, stream: n % 2 === 0 });
      expect(replay.status).toBe(400);
      expect(JSON.parse(replay.text)).toMatchObject({ retryable: false,
        error: { code, type } });
    }
    expect(starts).toBe(1); expect(sends).toBe(1);
    // Native reconnects can refresh developer context without creating a new user revision.
    const refreshed = await post({ ...body, input: [
      { role: "developer", content: [{ type: "input_text", text: "refreshed environment" }] }, ...body.input,
    ] });
    expect(refreshed.status).toBe(400); expect(starts).toBe(1);
    const completedTools = await post({ ...body, input: [...body.input,
      { type: "function_call", call_id: "completed-call", name: "exec_command", arguments: "{}" },
      { type: "function_call_output", call_id: "completed-call", output: "completed canonical result" },
    ] });
    expect(completedTools.status).toBe(400);
    expect(JSON.parse(completedTools.text).error.code).toBe(code);
    expect(starts).toBe(1); expect(sends).toBe(1);

    // Explicit new work or a changed model/effort must not inherit the rejected request.
    for (const changed of [request(body.prompt_cache_key, "turn-2"),
      request(body.prompt_cache_key, "turn-1", "user-2"),
      request(body.prompt_cache_key, "turn-1", "user-1", "chatgpt-web/gpt-5.6-sol"),
      { ...body, reasoning: { effort: "xhigh" } },
      request(randomUUID()),
      { ...body, input: [{ ...body.input[0], content: [{ type: "input_text", text: "changed task" }] }] }]) {
      expect((await post(changed)).status).toBe(200);
    }
    expect(starts).toBe(7); expect(sends).toBe(7);
    expect((await post(body)).status).toBe(400); expect(starts).toBe(7);
  } finally { await server.stop(true); chatGptTurnSessions.clear(); }
});

test("terminal completion receipts expire absolutely and do not capture retryable compact boundaries", () => {
  const policy = new ChatGptWebTurnRetryPolicy(100, 2);
  const error = chatGptCompletionEvidenceError("final recovery exhausted", true);
  policy.recordTerminalFailure("completed", error, 0);
  policy.clear("completed");
  policy.recordTerminalFailure("completed", error, 99);
  expect(policy.terminalFailure("completed", 99)).toBe(error);
  expect(policy.terminalFailure("completed", 100)).toBeUndefined();
  for (const ignored of [chatGptCompletionEvidenceError("active compaction boundary", false),
    new ChatGptWebAdapterError("surface changed", { status: 502, errorType: "server_error",
      code: "chatgpt_surface_changed", retryable: false })]) {
    policy.recordTerminalFailure("transient", ignored, 100);
    expect(policy.terminalFailure("transient", 101)).toBeUndefined();
  }
});

test("Enhanced compact model rejection blocks refreshed-harness reconnects but allows changed history", async () => {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-model-"));
  const config = defaultConfig("full"); config.port = 0;
  config.brokerSocketPath = defaultBrokerEndpoint(root);
  config.useEnhancedWebSessionMode = true;
  let starts = 0, sends = 0;
  const worker = { requestPreemptiveRetry: () => false, async run(turn: BrowserTurn): Promise<string> {
    starts++;
    const prepared = await turn.prepare(); prepared.release();
    await turn.onSendActivated?.(); sends++;
    throw chatGptModelUnavailableError();
  } };
  const server = startServer(config, { adapterFactory: p => createChatGptWebAdapter(p, { worker }) });
  const body = request(randomUUID());
  const post = async (data: object) => {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses/compact`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const first = await post(body);
    expect(first.body.error.message).toContain("Model not found");
    expect(starts).toBe(1); expect(sends).toBe(1);
    for (const data of [{ ...body, input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "updated harness" }] }, ...body.input,
    ] }, body]) {
      const replay = await post(data);
      expect(starts).toBe(1); expect(sends).toBe(1);
      expect(replay.status).toBe(400);
      expect(replay.body).toMatchObject({ retryable: false, error: { code: "model_not_found" } });
    }
    const changed = await post({ ...body, input: [...body.input,
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "new source work" }] },
    ] });
    expect(changed.body.error.message).toContain("Model not found");
    expect(starts).toBe(2); expect(sends).toBe(2);
  } finally {
    await server.stop(true); chatGptTurnSessions.clear();
    await TurnBroker.forSocket(config.brokerSocketPath).close();
    rmSync(root, { recursive: true, force: true });
  }
});
