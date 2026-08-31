import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const root = join(tmpdir(), `cgw-browser-token-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

function request(): CodexParsedRequest {
  const turnId = `turn_${Date.now()}`;
  const threadId = `thread_${Date.now()}`;
  const environment = `<environment_context><cwd>${root}</cwd><filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`;
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    context: {
      tools: [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }],
      messages: [
        { role: "user", content: environment, timestamp: 1 },
        { role: "user", content: "Inspect the project", timestamp: 2 },
      ],
    },
    options: { reasoning: "high" },
    _rawBody: {
      prompt_cache_key: threadId,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }) },
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: environment }], internal_chat_message_metadata_passthrough: { turn_id: turnId } },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the project" }], internal_chat_message_metadata_passthrough: { turn_id: turnId } },
      ],
    },
  };
}

test("a failed browser surface revokes an outstanding native tool invocation without another request", async () => {
  const socketPath = process.platform === "win32"
    ? defaultBrokerEndpoint(join(tmpdir(), `cgw-browser-token-${process.pid}-${Date.now()}`), "win32")
    : join(root, "broker.sock");
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "browser://chatgpt-token-lifecycle-test",
    chatgptWeb: { brokerSocketPath: socketPath, turnTimeoutMs: 30_000, localToolsEnabled: true, solAvailable: true, proAvailable: true },
  };
  const broker = TurnBroker.forSocket(socketPath);
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let failSurface!: (error: Error) => void;
  const surfaceFailure = new Promise<never>((_resolve, reject) => { failSurface = reject; });
  let invocationOutcome!: Promise<string>;

  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    const prepared = await turn.prepare();
    try {
      const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
      if (!token) throw new Error("turn token missing from compiled prompt");
      const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
      const invocation = callTurnBroker(socketPath, {
        method: "invoke",
        bindingId: claimed.bindingId,
        wireName: "exec_command",
        freeform: false,
        arguments: { cmd: "long-running-read" },
      }, 2_000);
      invocationOutcome = invocation.then(() => "completed", error => error instanceof Error ? error.message : String(error));
      await Promise.race([invocation, surfaceFailure]);
      return "unexpected completion";
    } finally {
      prepared.release();
    }
  };

  try {
    const events: AdapterEvent[] = [];
    await createChatGptWebAdapter(provider).runTurn!(request(), { headers: new Headers() }, event => events.push(event));
    expect(events.some(event => event.type === "tool_call_start")).toBe(true);

    failSurface(new Error("browser surface closed"));
    expect(await invocationOutcome).toContain("revoked");
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await broker.close();
  }
}, 10_000);

test("a browser failure remains the authoritative turn error while its token is revoked", async () => {
  const socketPath = process.platform === "win32"
    ? defaultBrokerEndpoint(join(tmpdir(), `cgw-browser-error-${process.pid}-${Date.now()}`), "win32")
    : join(root, "e.sock");
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "browser://chatgpt-error-authority-test",
    chatgptWeb: { brokerSocketPath: socketPath, localToolsEnabled: true, solAvailable: true, proAvailable: true },
  };
  const broker = TurnBroker.forSocket(socketPath);
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let failSurface!: (error: Error) => void;
  const surfaceFailure = new Promise<never>((_resolve, reject) => { failSurface = reject; });

  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    const prepared = await turn.prepare();
    try { return await surfaceFailure; }
    finally { prepared.release(); }
  };

  try {
    const running = createChatGptWebAdapter(provider).runTurn!(request(), { headers: new Headers() }, () => {});
    await Bun.sleep(10);
    failSurface(new Error("browser surface closed"));
    await expect(running).rejects.toThrow("browser surface closed");
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await broker.close();
  }
}, 10_000);
