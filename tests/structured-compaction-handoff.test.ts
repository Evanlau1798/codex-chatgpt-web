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
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
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

test("active structured compact waits for the Web conversation to end after a valid handoff", async () => {
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
    let settled = false;
    const compact = requestActiveCompactionHandoff(request(true), session, broker, undefined, 1_000)
      .then(value => { settled = true; return value; });
    while (!submitted) await Bun.sleep(1);
    await submitted;
    await Bun.sleep(10);
    expect(preemptions).toBe(1);
    expect(handoffDelivered).toBeTrue();
    expect(settled).toBeFalse();

    finishBrowser("The checkpoint Web turn has fully ended.");
    await expect(compact).resolves.toBe("Structured active checkpoint is valid.");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retained structured compact requires both a valid control submission and a completed Web turn", async () => {
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
  let finishBrowser!: (answer: string) => void;
  let submitted!: Promise<unknown>;
  let turn: BrowserTurn | undefined;
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
    return new Promise<string>(resolve => { finishBrowser = resolve; });
  } };

  try {
    let settled = false;
    const compact = requestRetainedCompactionHandoff(
      worker as never,
      request(true),
      source,
      broker as never,
      namespace,
      { localToolsEnabled: true, solAvailable: true, proAvailable: true },
      "trace_retained_structured",
    ).then(value => { settled = true; return value; });
    while (!submitted) await Bun.sleep(1);
    await submitted;
    await Bun.sleep(10);
    expect(settled).toBeFalse();
    expect(turn?.nativeConnector).toBeTrue();
    expect(turn?.requireRetainedConversation).toBeTrue();

    finishBrowser("The retained checkpoint Web turn has fully ended.");
    await expect(compact).resolves.toBe("Structured retained checkpoint is valid.");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
