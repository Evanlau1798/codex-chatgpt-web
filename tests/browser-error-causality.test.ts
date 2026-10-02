import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { callTurnBroker, RemoteTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

function request(root: string): CodexParsedRequest {
  const identity = root.split(/[\\/]/).at(-1) ?? "browser-error-causality";
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
      prompt_cache_key: `browser-error-causality-thread-${identity}`,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: `browser-error-causality-thread-${identity}`, turn_id: `browser-error-causality-turn-${identity}` }) },
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: environment }], internal_chat_message_metadata_passthrough: { turn_id: `browser-error-causality-turn-${identity}` } },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the project" }], internal_chat_message_metadata_passthrough: { turn_id: `browser-error-causality-turn-${identity}` } },
      ],
    },
  };
}

test("browser failure keeps its typed cause when broker cleanup wins the outcome race", async () => {
  const root = join(tmpdir(), `cgw-browser-error-causality-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const socketPath = defaultBrokerEndpoint(join(tmpdir(), `cgw-ec-${process.pid}`), process.platform);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "browser://chatgpt-error-causality-test",
    chatgptWeb: { brokerSocketPath: socketPath, localToolsEnabled: true, solAvailable: true, proAvailable: true },
  };
  const broker = TurnBroker.forSocket(socketPath);
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const browserError = new ChatGptWebAdapterError("browser surface closed", {
    status: 502,
    errorType: "server_error",
    code: "chatgpt_surface_changed",
    retryable: false,
  });
  const cleanupReasons: Array<Error | undefined> = [];
  const originalRevoke = broker.revoke.bind(broker);
  (broker as unknown as { revoke: (turnToken: string, reason?: Error) => void }).revoke = (turnToken, reason) => {
    cleanupReasons.push(reason);
    originalRevoke(turnToken, reason);
  };
  let failureTriggered = false;
  let token: string | undefined;
  const realSetTimeout = globalThis.setTimeout;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    const prepared = await turn.prepare();
    try {
      token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
      failureTriggered = true;
      throw browserError;
    } finally {
      prepared.release();
    }
  };
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (failureTriggered && delay === 0) {
      globalThis.setTimeout = realSetTimeout;
      if (typeof handler === "function") handler(...args);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(handler, delay, ...args);
  }) as typeof setTimeout;

  try {
    const events: AdapterEvent[] = [];
    const outcome = await createChatGptWebAdapter(provider).runTurn!(
      request(root), { headers: new Headers() }, event => events.push(event),
    ).then(() => undefined, error => error);
    expect(outcome).toBeUndefined();
    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: "browser surface closed",
      code: "chatgpt_surface_changed",
    });
    expect(cleanupReasons).toEqual([browserError]);
    expect(token).toBeString();
    await expect(broker.nextToolBatch(token!)).rejects.toThrow(/invalid|expired|revoked/);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test("browser failure keeps its cause through a remote broker owner", async () => {
  const root = join(tmpdir(), `cgw-browser-remote-causality-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const socketPath = defaultBrokerEndpoint(join(tmpdir(), `cgw-remote-ec-${process.pid}`), process.platform);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "browser://chatgpt-remote-error-causality-test",
    chatgptWeb: { brokerSocketPath: socketPath, localToolsEnabled: true, solAvailable: true, proAvailable: true },
  };
  const broker = TurnBroker.forSocket(socketPath);
  const remote = new RemoteTurnBroker(socketPath);
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const browserError = new ChatGptWebAdapterError("browser surface closed remotely", {
    status: 502,
    errorType: "server_error",
    code: "chatgpt_surface_changed",
    retryable: false,
  });
  let failSurface!: (error: Error) => void;
  const surfaceFailure = new Promise<never>((_resolve, reject) => { failSurface = reject; });
  let invocationOutcome!: Promise<string>;
  let token: string | undefined;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    const prepared = await turn.prepare();
    try {
      token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
      if (!token) throw new Error("turn token missing from compiled prompt");
      const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
      const invocation = callTurnBroker(socketPath, {
        method: "invoke",
        bindingId: claimed.bindingId,
        wireName: "exec_command",
        freeform: false,
        arguments: { cmd: "remote-long-running-read" },
      }, null);
      invocationOutcome = invocation.then(() => "completed", error => error instanceof Error ? error.message : String(error));
      const progress = turn.externalProgress;
      if (!progress) throw new Error("tool-capable browser has no progress transport");
      let snapshot = progress.snapshot();
      while (snapshot.lastToolBatchRevision === 0) {
        snapshot = await progress.waitForChange(snapshot.revision, turn.abortSignal);
      }
      await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
      await Promise.race([invocation, surfaceFailure]);
      return "unexpected completion";
    } finally {
      prepared.release();
    }
  };

  try {
    await broker.listen();
    const events: AdapterEvent[] = [];
    await createChatGptWebAdapter(provider, { broker: remote }).runTurn!(
      request(root), { headers: new Headers() }, event => events.push(event),
    );
    expect(events.some(event => event.type === "tool_call_start")).toBe(true);
    failSurface(browserError);
    expect(await invocationOutcome).toBe(browserError.message);
    expect(token).toBeString();
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test("remote NEXT cleanup does not replace the typed browser outcome", async () => {
  const root = join(tmpdir(), `cgw-browser-remote-next-causality-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const socketPath = defaultBrokerEndpoint(join(tmpdir(), `cgw-remote-next-ec-${process.pid}`), process.platform);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "browser://chatgpt-remote-next-error-causality-test",
    chatgptWeb: { brokerSocketPath: socketPath, localToolsEnabled: true, solAvailable: true, proAvailable: true },
  };
  const broker = TurnBroker.forSocket(socketPath);
  const remote = new RemoteTurnBroker(socketPath);
  const originalNext = remote.nextToolBatch.bind(remote);
  const originalRevoke = remote.revoke.bind(remote);
  const revokePromises: Promise<void>[] = [];
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const browserError = new ChatGptWebAdapterError("browser NEXT race closed", {
    status: 502,
    errorType: "server_error",
    code: "chatgpt_surface_changed",
    retryable: false,
  });
  let markNextStarted!: () => void;
  const nextStarted = new Promise<void>(resolve => { markNextStarted = resolve; });
  let rejectNext!: (error: Error) => void;
  (remote as unknown as { nextToolBatch: typeof remote.nextToolBatch }).nextToolBatch = async (token, signal) => {
    markNextStarted();
    void originalNext(token, signal).catch(() => {});
    return new Promise<never>((_resolve, reject) => { rejectNext = reject; });
  };
  (remote as unknown as { revoke: typeof remote.revoke }).revoke = async (token, reason) => {
    // Force the remote owner_next response to win this test's ordering. The real owner revoke
    // still runs so the test exercises the production RemoteTurnBroker transport and cleanup.
    rejectNext(new Error("Codex turn binding was revoked"));
    const revoke = originalRevoke(token, reason);
    revokePromises.push(revoke);
    await revoke;
  };
  let failureTriggered = false;
  const realSetTimeout = globalThis.setTimeout;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    const prepared = await turn.prepare();
    try {
      await nextStarted;
      failureTriggered = true;
      throw browserError;
    } finally {
      prepared.release();
    }
  };
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (failureTriggered && delay === 0) {
      globalThis.setTimeout = realSetTimeout;
      if (typeof handler === "function") handler(...args);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(handler, delay, ...args);
  }) as typeof setTimeout;

  try {
    await broker.listen();
    const events: AdapterEvent[] = [];
    const outcome = await createChatGptWebAdapter(provider, { broker: remote }).runTurn!(
      request(root), { headers: new Headers() }, event => events.push(event),
    ).then(() => undefined, error => error);
    expect(outcome).toBeUndefined();
    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: browserError.message,
      status: browserError.status,
      errorType: browserError.errorType,
      code: browserError.code,
      retryable: browserError.retryable,
    });
  } finally {
    globalThis.setTimeout = realSetTimeout;
    await Promise.allSettled(revokePromises);
    (remote as unknown as { nextToolBatch: typeof remote.nextToolBatch }).nextToolBatch = originalNext;
    (remote as unknown as { revoke: typeof remote.revoke }).revoke = originalRevoke;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
