import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import type { CodexParsedRequest, CodexProviderConfig } from "../src/types";

const brokers = new Set<TurnBroker>();

afterEach(async () => {
  for (const broker of brokers) await broker.close();
  brokers.clear();
});

function brokerEndpoint(name: string): string {
  return process.platform === "win32"
    ? defaultBrokerEndpoint(join(tmpdir(), name), "win32")
    : join(tmpdir(), `${name}.sock`);
}

function requestWithUnserializableContext(root: string): CodexParsedRequest {
  const environment = [
    "<environment_context>",
    `  <cwd>${root}</cwd>`,
    `  <workspace_roots><root>${root}</root></workspace_roots>`,
    "  <sandbox_mode>danger-full-access</sandbox_mode>",
    "</environment_context>",
  ].join("\n");
  const threadId = "thread_preparation_diagnostic";
  const turnId = "turn_preparation_diagnostic";
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    options: { reasoning: "xhigh" },
    context: {
      systemPrompt: [1n as unknown as string],
      messages: [
        { role: "user", content: environment, timestamp: 1 },
        { role: "user", content: "Inspect the project.", timestamp: 2 },
      ],
      tools: [{
        name: "diagnostic_fixture",
        description: "A generic preparation fixture.",
        parameters: { type: "object", properties: {} },
      }],
    },
    _rawBody: {
      prompt_cache_key: threadId,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
      },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: environment }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }, {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Inspect the project." }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }],
    },
  };
}

test("prompt preparation failures remain authoritative across broker revocation", async () => {
  const root = join(tmpdir(), `codex-preparation-diagnostic-${process.pid}`);
  const socketPath = brokerEndpoint(`cgw-preparation-diagnostic-${process.pid}-${Date.now()}`);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://preparation-diagnostic-${Date.now()}`,
    chatgptWeb: {
      brokerSocketPath: socketPath,
      localToolsEnabled: true,
      solAvailable: true,
      proAvailable: true,
      useEnhancedWebSessionMode: true,
    },
  };
  const broker = TurnBroker.forSocket(socketPath);
  brokers.add(broker);
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    const prepared = await turn.prepare();
    prepared.release();
    return "unexpected";
  };
  const diagnostics: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => diagnostics.push(values.map(String).join(" "));

  try {
    const adapter = createChatGptWebAdapter(provider);
    await expect(adapter.runTurn!(
      requestWithUnserializableContext(root),
      { headers: new Headers() },
      () => {},
    )).rejects.toThrow(/BigInt/);
    expect(diagnostics).toContainEqual(expect.stringContaining(
      "stage=prompt_preparation source=full",
    ));
    expect(diagnostics).toContainEqual(expect.stringContaining(
      "errorName=\"TypeError\" errorCode=\"none\"",
    ));
    expect(diagnostics.some(line => line.includes("errorMessage=") && line.includes("BigInt"))).toBe(true);
    expect(diagnostics.join("\n")).not.toContain("Inspect the project");
  } finally {
    console.error = originalError;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    rmSync(root, { recursive: true, force: true });
  }
});
