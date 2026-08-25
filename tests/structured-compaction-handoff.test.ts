import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { requestActiveCompactionHandoff } from "../src/adapters/chatgpt-web/compaction-handoff";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { requestRetainedCompactionHandoff } from "../src/adapters/chatgpt-web/retained-compaction-handoff";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import type { CodexParsedRequest } from "../src/types";

function request(compaction = false): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    context: { messages: [{ role: "user", content: "Continue the implementation", timestamp: 1 }] },
    options: { reasoning: "high" },
    _compactionRequest: compaction,
    _rawBody: {
      prompt_cache_key: "thread_structured_compaction",
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({
        thread_id: "thread_structured_compaction",
        turn_id: compaction ? "turn_compact" : "turn_source",
      }) },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue the implementation" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_source" },
      }],
    },
  };
}

function controlBinding(instruction: string): { token: string; handoffId: string } {
  const token = instruction.match(/turn_token (control_[a-f0-9]{32})/)?.[1];
  const handoffId = instruction.match(/handoff_id (handoff_[a-f0-9]{32})/)?.[1];
  if (!token || !handoffId) throw new Error(`missing structured control binding: ${instruction}`);
  expect(instruction).toContain("codex.control.compaction_handoff");
  return { token, handoffId };
}

test("active structured compact accepts a valid checkpoint before fragile Web completion evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-active-structured-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  let finishBrowser!: (answer: string) => void;
  const browser = new Promise<string>(resolve => { finishBrowser = resolve; });
  let submitted!: Promise<unknown>;
  let preemptions = 0;
  let handoffDelivered = false;
  const session = new ChatGptTurnSession({
    mode: "read-only",
    browser,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: request(false),
    preemptHandoff: (instruction: string) => {
      controlBinding(String(instruction));
      preemptions += 1;
      return true;
    },
    requestHandoff: (instruction: string, delivered?: boolean) => {
      handoffDelivered = delivered === true;
      const binding = controlBinding(String(instruction));
      submitted = callTurnBroker(broker.socketPath, {
        method: "submit_compaction_handoff",
        token: binding.token,
        handoffId: binding.handoffId,
        summary: "Structured active checkpoint is valid.",
      });
    },
    cancel: () => {},
  } as never);
  try {
    const compact = requestActiveCompactionHandoff(request(true), session, broker, undefined, 1_000);
    while (!submitted) await Bun.sleep(1);
    await submitted;
    expect(preemptions).toBe(1);
    expect(handoffDelivered).toBeTrue();
    await expect(compact).resolves.toBe("Structured active checkpoint is valid.");
    finishBrowser("The checkpoint Web turn was retired after its structured submission.");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("active read-only compact without a handoff continuation does not create a control waiter", async () => {
  let transactions = 0;
  const broker = {
    beginCompactionTransaction: async () => {
      transactions += 1;
      return {
        token: "control_11111111111111111111111111111111",
        handoffId: "handoff_22222222222222222222222222222222",
      };
    },
    waitForCompactionHandoff: async () => "unreachable",
    abortCompactionTransaction: () => {},
  } as unknown as TurnBroker;
  const session = new ChatGptTurnSession({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: request(false),
    cancel: () => {},
  });

  await expect(requestActiveCompactionHandoff(request(true), session, broker)).resolves.toBeUndefined();
  expect(transactions).toBe(0);
});

test("active structured compact observes a signal that was aborted before browser waiting began", async () => {
  const broker = {
    beginCompactionTransaction: async () => ({
      token: "control_11111111111111111111111111111111",
      handoffId: "handoff_22222222222222222222222222222222",
    }),
    waitForCompactionHandoff: () => new Promise<string>(() => {}),
    abortCompactionTransaction: () => {},
  } as unknown as TurnBroker;
  const session = new ChatGptTurnSession({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: request(false),
    requestHandoff: () => {},
    cancel: () => {},
  });
  const abort = new AbortController();
  abort.abort();

  const outcome = await Promise.race([
    requestActiveCompactionHandoff(request(true), session, broker, abort.signal, 1_000)
      .then(() => "resolved", error => error instanceof DOMException ? error.name : "wrong-error"),
    Bun.sleep(100).then(() => "abort-not-observed"),
  ]);

  expect(outcome).toBe("AbortError");
});

test("active structured compact attaches its one-shot handoff to only one result in a parallel tool batch", async () => {
  let finishBrowser!: (answer: string) => void;
  const completed: Array<{ callId: string; result: BrokerToolResult }> = [];
  let queuedHandoffs = 0;
  const broker = {
    beginCompactionTransaction: async () => ({
      token: "control_11111111111111111111111111111111",
      handoffId: "handoff_22222222222222222222222222222222",
    }),
    waitForCompactionHandoff: async () => "Structured parallel checkpoint is valid.",
    completeTool: (_token: string, callId: string, result: BrokerToolResult) => {
      completed.push({ callId, result });
    },
    requestHandoff: () => {
      queuedHandoffs += 1;
      return "queued" as const;
    },
    abortCompactionTransaction: () => {},
  } as unknown as TurnBroker;
  const session = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve("turn_parallel"),
    browser: new Promise<string>(resolve => { finishBrowser = resolve; }),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: request(false),
    cancel: () => {},
  });
  session.setOutstanding([
    { callId: "call_first", wireName: "exec_command", freeform: false },
    { callId: "call_second", wireName: "exec_command", freeform: false },
  ]);
  const parsed = request(true);
  parsed.context.messages.push(
    {
      role: "toolResult",
      toolCallId: "call_first",
      toolName: "exec_command",
      content: "first result",
      isError: false,
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call_second",
      toolName: "exec_command",
      content: "second result",
      isError: false,
      timestamp: 3,
    },
  );

  const compact = requestActiveCompactionHandoff(parsed, session, broker, undefined, 1_000);
  while (completed.length < 2) await Bun.sleep(1);
  finishBrowser("The parallel checkpoint Web turn has fully ended.");

  await expect(compact).resolves.toBe("Structured parallel checkpoint is valid.");
  expect(completed.map(entry => entry.callId)).toEqual(["call_first", "call_second"]);
  expect(JSON.stringify(completed)).toContain("first result");
  expect(JSON.stringify(completed)).toContain("second result");
  expect(JSON.stringify(completed).match(/codex\.control\.compaction_handoff/g)?.length).toBe(1);
  expect(queuedHandoffs).toBe(0);
});

test("retained structured compact stops the Web response after a valid control submission", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-retained-structured-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const namespace = createHash("sha256").update("retained-structured").digest("hex");
  const source = new ChatGptTurnSession({
    mode: "read-only",
    browser: Promise.resolve("source completed"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: request(false),
    cancel: () => {},
  });
  let submitted!: Promise<unknown>;
  let turn: BrowserTurn | undefined;
  let browserAborted = false;
  const worker = { run: async (value: BrowserTurn) => {
    turn = value;
    const prepared = await value.prepare();
    const binding = controlBinding(prepared.text);
    prepared.release();
    submitted = callTurnBroker(broker.socketPath, {
      method: "submit_compaction_handoff",
      token: binding.token,
      handoffId: binding.handoffId,
      summary: "Structured retained checkpoint is valid.",
    });
    return new Promise<string>((_resolve, reject) => {
      value.abortSignal?.addEventListener("abort", () => {
        browserAborted = true;
        reject(new DOMException("retained checkpoint retired", "AbortError"));
      }, { once: true });
    });
  } };

  try {
    const compact = requestRetainedCompactionHandoff(
      worker as never,
      request(true),
      source,
      broker as never,
      namespace,
      { localToolsEnabled: true, solAvailable: true, proAvailable: true },
      "trace_retained_structured",
    );
    while (!submitted) await Bun.sleep(1);
    await submitted;
    expect(turn?.nativeConnector).toBeTrue();
    expect(turn?.requireRetainedConversation).toBeTrue();

    await expect(compact).resolves.toBe("Structured retained checkpoint is valid.");
    expect(browserAborted).toBeTrue();
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
