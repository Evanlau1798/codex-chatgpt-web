import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import type { BrowserTurn, ResolvedBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { LAUNCHER_BROWSER_HOST_KIND } from "../src/launcher-browser-host";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("Bun daemon prepares only the resume prompt selected by the persistent Node helper", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-helper-client-"));
  roots.push(root);
  const helper = join(root, "helper.cjs");
  writeFileSync(helper, `
    const readline = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    let selected;
    send({ type: "ready" });
    readline.on("line", line => {
      let message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
      if (message.type === "prepared_selected_ack") {
        if (!selected || message.id !== selected.id) process.exit(2);
        if (message.prepared?.text !== "continue") process.exit(3);
        message = selected;
        selected = undefined;
        send({ type: "event", id: message.id, event: "submitted" });
        send({ type: "event", id: message.id, event: "reasoning", text: " files", continuation: true });
        send({ type: "event", id: message.id, event: "text", text: "done" });
        if (message.turn.captureLunaCheckpoint) send({
          type: "event",
          id: message.id,
          event: "luna_checkpoint",
          answerHash: "a".repeat(64),
          checkpoint: {
            version: 1,
            objective: "Finish the helper test.",
            state: ["The answer streamed."],
            evidence: ["The helper emitted a checkpoint event."],
            decisions: [],
            pending: [],
          },
        });
        send({ type: "result", id: message.id, text: "done" });
        return;
      }
      if (message.type !== "run") return;
      if (message.turn.prepared !== undefined
        || message.turn.resumePrepared !== undefined
        || message.turn.retainConversation !== true
        || message.turn.requireRetainedConversation !== true
        || message.turn.conversationKey !== "a".repeat(64)) {
        send({ type: "error", id: message.id, message: "resume payload missing" });
        return;
      }
      send({ type: "event", id: message.id, event: "reasoning", text: "Reading project" });
      send({ type: "event", id: message.id, event: "prepared_selected", reused: true });
      selected = message;
    });
  `, { mode: 0o700 });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 1,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    pid: process.pid,
    endpoint: "http://127.0.0.1:39001",
    control: {
      endpoint: "http://127.0.0.1:39002",
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: { executable: process.execPath, script: helper },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank#codex-web-gpt-browser-host",
    surfaceId: "launcher_surface_id_0123456789AB",
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const config: ResolvedBrowserConfig = {
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  };
  const reasoning: Array<{ text: string; continuation: boolean }> = [];
  const deltas: string[] = [];
  const checkpoints: unknown[] = [];
  let submitted = false;
  let released = false;
  let resumeReleased = false;
  let fullPrepareCount = 0;
  let resumePrepareCount = 0;
  const client = new LauncherBrowserHelperClient(config);
  try {
    const result = await client.run({
      traceId: "abcdef123456",
      modelId: "gpt-5.6-sol",
      reasoning: "high",
      capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false },
      prepare: async () => {
        fullPrepareCount += 1;
        return { text: "inspect", images: [], release: () => { released = true; } };
      },
      prepareResume: async () => {
        resumePrepareCount += 1;
        return { text: "continue", images: [], release: () => { resumeReleased = true; } };
      },
      retainConversation: true,
      requireRetainedConversation: true,
      conversationKey: "a".repeat(64),
      onReasoningSummary: (text, continuation) => reasoning.push({ text, continuation: continuation === true }),
      onSubmitted: () => { submitted = true; },
      onTextDelta: text => deltas.push(text),
      captureLunaCheckpoint: true,
      onLunaCheckpoint: checkpoint => checkpoints.push(checkpoint),
    });
    expect(result).toBe("done");
    expect(fullPrepareCount).toBe(0);
    expect(resumePrepareCount).toBe(1);
    expect(reasoning).toEqual([
      { text: "Reading project", continuation: false },
      { text: " files", continuation: true },
    ]);
    expect(deltas).toEqual(["done"]);
    expect(submitted).toBe(true);
    expect(checkpoints).toEqual([{
      answerHash: "a".repeat(64),
      checkpoint: {
        version: 1,
        objective: "Finish the helper test.",
        state: ["The answer streamed."],
        evidence: ["The helper emitted a checkpoint event."],
        decisions: [],
        pending: [],
      },
    }]);
    expect(released).toBe(false);
    expect(resumeReleased).toBe(true);
  } finally {
    await client.close();
  }
});

test("a rejected prompt preparation releases the helper turn before the trace can be reused", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-helper-release-"));
  roots.push(root);
  const helper = join(root, "helper.cjs");
  writeFileSync(helper, `
    const readline = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    const active = new Set();
    send({ type: "ready" });
    readline.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
      if (message.type === "abort") {
        if (!active.delete(message.id)) return;
        send({ type: "error", id: message.id, name: "AbortError", message: "released" });
        return;
      }
      if (message.type === "prepared_selected_ack") {
        if (!active.delete(message.id)) process.exit(3);
        send({ type: "result", id: message.id, text: "done" });
        return;
      }
      if (message.type !== "run") return;
      if (active.has(message.id)) {
        send({ type: "error", id: message.id, message: "Browser helper turn already exists: " + message.id });
        return;
      }
      active.add(message.id);
      send({ type: "event", id: message.id, event: "prepared_selected", reused: false });
    });
  `, { mode: 0o700 });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 1,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    pid: process.pid,
    endpoint: "http://127.0.0.1:39001",
    control: {
      endpoint: "http://127.0.0.1:39002",
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: { executable: process.execPath, script: helper },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank#codex-web-gpt-browser-host",
    surfaceId: "launcher_surface_id_0123456789AB",
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  });
  const turn = (prepare: BrowserTurn["prepare"]): BrowserTurn => ({
    traceId: "reusable-trace-123",
    modelId: "gpt-5.6-sol",
    capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false },
    prepare,
    onTextDelta() {},
  });
  try {
    await expect(client.run(turn(async () => { throw new Error("prompt preparation failed"); })))
      .rejects.toThrow("prompt preparation failed");
    await expect(client.run(turn(async () => ({ text: "inspect", images: [], release() {} }))))
      .resolves.toBe("done");
  } finally {
    await client.close();
  }
});

test("an abort dispatched during run submission cannot overtake the run frame", async () => {
  const controller = new AbortController();
  const messages: string[] = [];
  let released = false;
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  });
  const internal = client as unknown as {
    ensureChild(): Promise<void>;
    send(message: { type: string; id?: string }): Promise<void>;
    finishWithError(id: string, error: Error): void;
  };
  internal.ensureChild = async () => {};
  internal.send = async message => {
    messages.push(message.type);
    if (message.type === "run") controller.abort();
    if (message.type === "abort" && message.id) {
      queueMicrotask(() => internal.finishWithError(
        message.id!,
        new DOMException("ChatGPT web turn aborted", "AbortError"),
      ));
    }
  };

  await expect(client.run({
    traceId: "abort-order-123",
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false },
    abortSignal: controller.signal,
    prepare: async () => ({
      text: "inspect",
      images: [],
      release: () => { released = true; },
    }),
    onTextDelta: () => {},
  })).rejects.toMatchObject({ name: "AbortError" });

  expect(messages).toEqual(["run", "abort"]);
  expect(released).toBe(false);
});

test("structured helper errors preserve the ChatGPT adapter failure contract", async () => {
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  });
  const internal = client as unknown as {
    child?: unknown;
    pending: Map<string, {
      turn: BrowserTurn;
      resolve: (value: string) => void;
      reject: (error: Error) => void;
    }>;
    handleLine(child: unknown, line: string): void;
  };
  const child = {};
  internal.child = child;
  const result = new Promise<string>((resolveResult, rejectResult) => {
    internal.pending.set("rate-limit-123", {
      turn: {
        traceId: "rate-limit-123",
        modelId: "chatgpt-web/medium",
        capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false },
        prepare: async () => ({ text: "inspect", images: [], release() {} }),
        onTextDelta() {},
      },
      resolve: resolveResult,
      reject: rejectResult,
    });
  });

  internal.handleLine(child, JSON.stringify({
    type: "error",
    id: "rate-limit-123",
    name: "ChatGptWebAdapterError",
    message: "ChatGPT rate limit: too many requests are being made too quickly. Wait before retrying.",
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
  }));

  const error = await result.then(() => undefined, failure => failure);
  expect(error).toBeInstanceOf(ChatGptWebAdapterError);
  expect(error).toMatchObject({
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
  });
});

test("a synchronous answer retry failure rejects only its browser turn", async () => {
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  });
  const internal = client as unknown as {
    child?: unknown;
    pending: Map<string, {
      turn: BrowserTurn;
      resolve: (value: string) => void;
      reject: (error: Error) => void;
    }>;
    handleLine(child: unknown, line: string): void;
  };
  const child = {};
  internal.child = child;
  const result = new Promise<string>((resolveResult, rejectResult) => {
    internal.pending.set("answer-retry-123", {
      turn: {
        traceId: "answer-retry-123",
        modelId: "chatgpt-web/medium",
        capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false },
        prepare: async () => ({ text: "inspect", images: [], release() {} }),
        onTextDelta() {},
        retryPromptForAnswer: () => { throw new Error("subagent retry refused"); },
      },
      resolve: resolveResult,
      reject: rejectResult,
    });
  });

  expect(() => internal.handleLine(child, JSON.stringify({
    type: "event",
    id: "answer-retry-123",
    event: "answer",
    text: "native command gateway unavailable",
    attempt: 2,
  }))).not.toThrow();

  await expect(result).rejects.toThrow("subagent retry refused");
});

test("launcher helper retries recoverable browser failures in the same turn", async () => {
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  });
  const sent: unknown[] = [];
  let failure = "";
  const internal = client as unknown as {
    child?: unknown;
    pending: Map<string, { turn: BrowserTurn; resolve: (value: string) => void; reject: (error: Error) => void }>;
    handleLine(child: unknown, line: string): void;
    send(message: unknown): Promise<void>;
  };
  const child = {};
  internal.child = child;
  internal.send = async message => { sent.push(message); };
  internal.pending.set("compact-retry-123", {
    turn: {
      traceId: "compact-retry-123",
      modelId: "gpt-5.6-sol",
      capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
      prepare: async () => ({ text: "inspect", images: [], release() {} }),
      onTextDelta() {},
      retryPromptForError: error => {
        failure = error.message;
        return "retry checkpoint";
      },
    },
    resolve() {},
    reject() {},
  });

  internal.handleLine(child, JSON.stringify({
    type: "event",
    id: "compact-retry-123",
    event: "error_retry",
    text: "ChatGPT completed text block changed",
    attempt: 1,
  }));
  await new Promise(resolve => setTimeout(resolve, 0));

  expect(failure).toBe("ChatGPT completed text block changed");
  expect(sent).toEqual([{
    type: "answer_retry",
    id: "compact-retry-123",
    prompt: "retry checkpoint",
  }]);
});

test("launcher helper preserves retry submission acknowledgement across the process boundary", async () => {
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native", browserHost: "launcher", browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json", chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000, headed: true, autoApproveToolCalls: false,
  });
  const sent: unknown[] = [];
  let acknowledged = false;
  const internal = client as unknown as {
    child?: unknown;
    pending: Map<string, { turn: BrowserTurn; resolve: (value: string) => void; reject: (error: Error) => void }>;
    handleLine(child: unknown, line: string): void;
    send(message: unknown): Promise<void>;
  };
  const child = {};
  internal.child = child;
  internal.send = async message => { sent.push(message); };
  internal.pending.set("steering-retry-123", {
    turn: {
      traceId: "steering-retry-123", modelId: "chatgpt-web/medium",
      capabilities: { localToolsEnabled: true, solAvailable: true, proAvailable: false },
      prepare: async () => ({ text: "inspect", images: [], release() {} }), onTextDelta() {},
      retryPromptForAnswer: () => ({ text: "apply steering", onSubmitted: () => { acknowledged = true; } }),
    },
    resolve() {}, reject() {},
  });

  internal.handleLine(child, JSON.stringify({
    type: "event", id: "steering-retry-123", event: "answer", text: "initial answer", attempt: 1,
  }));
  await new Promise(resolve => setTimeout(resolve, 0));

  expect(sent).toEqual([{ type: "answer_retry", id: "steering-retry-123", prompt: "apply steering", acknowledge: true }]);
  expect(acknowledged).toBe(false);
  internal.handleLine(child, JSON.stringify({ type: "event", id: "steering-retry-123", event: "retry_submitted" }));
  expect(acknowledged).toBe(true);
});
