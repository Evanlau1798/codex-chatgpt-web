import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHATGPT_WEB_BACKEND_MODEL, CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import { defaultBrokerEndpoint } from "../src/config";
import { retainedSystemContextArchive } from "../src/adapters/chatgpt-web/context-bootstrap";
import { RetainedContextArchiveRecovery } from "../src/adapters/chatgpt-web/context-archive-recovery";
import { reuseChatGptConnectorSelection } from "../src/adapters/chatgpt-web/browser-prompt-mode";
import { createChatGptRuntimeStarter } from "../src/adapters/chatgpt-web/adapter-runtime-factory";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { retainedConversationResumeRequest } from "../src/adapters/chatgpt-web/steering";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import { ChatGptLunaCheckpointStore } from "../src/adapters/chatgpt-web/rolling-checkpoint";
import {
  createZeroRiskRuntimeStarter,
  type ChatGptZeroRiskManualControl,
} from "../src/adapters/chatgpt-web/zero-risk-runtime";
import type { CodexParsedRequest } from "../src/types";

const root = mkdtempSync(join(tmpdir(), "cgw-retained-system-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("retained archive refresh reattaches the connector for every browser response", () => {
  expect(reuseChatGptConnectorSelection("retained-system-archive", true, 1)).toBeFalse();
  expect(reuseChatGptConnectorSelection("retained-system-archive", true, 2)).toBeFalse();
  expect(reuseChatGptConnectorSelection("inline", true, 1)).toBeTrue();
  expect(reuseChatGptConnectorSelection("inline", false, 2)).toBeTrue();
  const worker = readFileSync(join(import.meta.dir, "../src/adapters/chatgpt-web/browser-worker.ts"), "utf8");
  const responseLoop = worker.indexOf("for (let responseAttempt = 1;");
  const responseBudget = worker.indexOf("const responseConnectorAttemptBudget", responseLoop);
  expect(responseBudget).toBeGreaterThan(responseLoop);
  expect(worker.indexOf("responseConnectorAttemptBudget", responseBudget + 1)).toBeGreaterThan(responseBudget);
});

test("a skipped retained archive resumes at the broker-confirmed chunk before failing closed", async () => {
  const contextBlocker = { begin: async () => ({ blocked: "context_archive" as const, nextIndex: 2 }), commit: async () => true };
  const recovery = new RetainedContextArchiveRecovery("retained-system-archive", contextBlocker);
  const first = await recovery.completion(undefined);
  expect(first.status).toBe("retry");
  if (first.status !== "retry") throw new Error("expected retained archive correction");
  expect(first.prompt).toContain('query "__codex_context__:2"');
  expect(await new RetainedContextArchiveRecovery("retained-system-archive", {
    begin: async () => ({ blocked: "activity" }), commit: async () => true,
  }).completion(undefined)).toEqual({ status: "wait" });
  expect(await new RetainedContextArchiveRecovery("inline", contextBlocker).completion(undefined)).toEqual({ status: "wait" });
  await expect(recovery.completion(undefined)).rejects.toThrow(
    "did not read the required context archive",
  );
});

test("retained refresh discards trace output produced before archive confirmation", () => {
  const output: string[] = [];
  const gate = new RetainedContextArchiveRecovery("retained-system-archive").outputGate({
    reasoning: value => output.push(`reasoning:${value}`),
    commentary: value => output.push(`commentary:${value}`),
  });
  gate.reasoning("stale");
  gate.commentary("stale");
  expect(output).toEqual([]);
  gate.commit();
  expect(output).toEqual([]);
  gate.commentary("current");
  expect(output.at(-1)).toBe("commentary:current");
});

test("archive correction folds an already pending preemptive retry into the same next response", async () => {
  const recovery = new RetainedContextArchiveRecovery("retained-system-archive");
  let answerRetries = 0;
  const corrected = await recovery.selectRetry("read archive", "compact checkpoint", () => {
    answerRetries += 1;
    return "answer retry";
  });
  expect(corrected.prompt).toContain("read archive");
  expect(corrected.prompt).toContain("compact checkpoint");
  expect(corrected.pendingPreemptiveRetry).toBeUndefined();
  expect(answerRetries).toBe(0);
});

function request(): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL,
    stream: true,
    options: { reasoning: "medium" },
    context: {
      systemPrompt: [`SYSTEM_SENTINEL_${"stable ".repeat(3_000)}`],
      tools: [{ name: "exec_command", description: "Run a command", parameters: { type: "object" } }],
      messages: [
        { role: "assistant", content: [{ type: "text", text: "Earlier answer" }], timestamp: 1 },
        { role: "user", content: "Continue now", timestamp: 2 },
      ],
    },
  };
}

test("retained refresh keeps the exact system out of the composer prompt", () => {
  const parsed = request();
  const refresh = retainedConversationResumeRequest(parsed, true)!;
  const requestId = `request_${"a".repeat(32)}`;
  const capabilities = { localToolsEnabled: true, solAvailable: true, proAvailable: true };
  const full = compileChatGptWebPrompt(parsed, capabilities, requestId, { manualControl: true });
  const compiled = compileChatGptWebPrompt(refresh, capabilities, requestId, { manualControl: true });

  expect(full.text).toContain("SYSTEM_SENTINEL_");
  expect(compiled.text).not.toContain("SYSTEM_SENTINEL_");
  expect(compiled.text).toContain("__codex_context__:0");
  expect(compiled.text).toContain("mandatory even when no other tool is needed");
  expect(compiled.text.length).toBeLessThan(full.text.length * 0.3);
  expect(retainedSystemContextArchive(parsed.context.systemPrompt!)).toContain("SYSTEM_SENTINEL_");
});

test("stable retained resumes never replay or accumulate system instructions", () => {
  const parsed = request();
  const capabilities = { localToolsEnabled: true, solAvailable: true, proAvailable: true };
  const full = compileChatGptWebPrompt(parsed, capabilities, `request_${"a".repeat(32)}`, {
    manualControl: true,
  });
  const lengths = Array.from({ length: 100 }, (_, index) => {
    const resumed = retainedConversationResumeRequest({
      ...parsed,
      context: {
        ...parsed.context,
        messages: [
          parsed.context.messages[0]!,
          { role: "user", content: `Continue ${String(index).padStart(3, "0")}`, timestamp: index + 2 },
        ],
      },
    })!;
    const compiled = compileChatGptWebPrompt(
      resumed,
      capabilities,
      `request_${String(index).padStart(32, "0")}`,
      { manualControl: true },
    );
    expect(compiled.text).not.toContain("SYSTEM_SENTINEL_");
    return compiled.text.length;
  });

  expect(Math.max(...lengths)).toBeLessThan(full.text.length * 0.3);
  expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(10);
});

test("Automatic Native2 prepares a short archive-backed refresh on the retained surface", async () => {
  const socketPath = defaultBrokerEndpoint(join(root, "automatic-broker"));
  const broker = TurnBroker.forSocket(socketPath);
  const parsed = request();
  parsed.modelId = CHATGPT_WEB_BACKEND_MODEL;
  parsed._rawBody = {
    input: [{
      type: "message", role: "user", content: [{ type: "input_text", text: "Continue now" }],
      internal_chat_message_metadata_passthrough: { turn_id: "refresh-turn" },
    }],
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: "refresh-thread", turn_id: "refresh-turn" }),
    },
  };
  let observed: BrowserTurn | undefined;
  try {
    const start = createChatGptRuntimeStarter({
      provider: { adapter: "chatgpt-web", baseUrl: "http://fixture", chatgptWeb: {
        browserHost: "launcher", browserHostDescriptorPath: join(root, "launcher.json"),
      } },
      worker: { async run(turn) {
        observed = turn;
        const prepared = await turn.prepareRefresh!();
        try {
          expect(prepared.transport).toBe("retained-system-archive");
          expect(prepared.text).not.toContain("SYSTEM_SENTINEL_");
          expect(prepared.text).toContain("mandatory even when no other tool is needed");
          expect(prepared.archiveChars).toBeGreaterThan(20_000);
        } finally {
          prepared.release();
        }
        return "done";
      } },
      broker,
      brokerOwner: broker,
      useEnhancedWebSessionMode: true,
      experimentalBiggerContext: false,
      configuredCapabilities: { localToolsEnabled: true, solAvailable: true, proAvailable: true },
      executionNamespace: "refresh-production",
      lunaCheckpointStore: new ChatGptLunaCheckpointStore(),
    });
    const runtime = start(parsed, {
      cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" }, tools: [],
    }, "refresh-trace", { localToolsEnabled: true, solAvailable: true, proAvailable: true });
    await expect(runtime.browser).resolves.toBe("done");
    expect(observed?.conversationKey).toMatch(/^[a-f0-9]{64}$/);
    expect(observed?.systemRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(observed?.prepareResume).toBeDefined();
    expect(observed?.prepareRefresh).toBeDefined();
    runtime.cancel();
  } finally {
    await broker.close();
  }
});

test("browser-only turns do not offer an unverifiable retained system refresh", async () => {
  const socketPath = defaultBrokerEndpoint(join(root, "browser-only-broker"));
  const broker = TurnBroker.forSocket(socketPath);
  const parsed = request();
  parsed.modelId = CHATGPT_WEB_BACKEND_MODEL;
  parsed._rawBody = {
    input: [{
      type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }],
      internal_chat_message_metadata_passthrough: { turn_id: "browser-only-turn" },
    }],
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: "browser-only-thread", turn_id: "browser-only-turn" }),
    },
  };
  let observed: BrowserTurn | undefined;
  try {
    const start = createChatGptRuntimeStarter({
      provider: { adapter: "chatgpt-web", baseUrl: "http://fixture", chatgptWeb: {
        browserHost: "launcher", browserHostDescriptorPath: join(root, "browser-only-launcher.json"),
      } },
      worker: { async run(turn) { observed = turn; return "done"; } },
      broker,
      brokerOwner: broker,
      useEnhancedWebSessionMode: true,
      experimentalBiggerContext: false,
      configuredCapabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
      executionNamespace: "browser-only-refresh",
      lunaCheckpointStore: new ChatGptLunaCheckpointStore(),
    });
    const runtime = start(parsed, {
      cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" }, tools: [],
    }, "browser-only-trace", {
      localToolsEnabled: false, solAvailable: true, proAvailable: true,
    });
    await expect(runtime.browser).resolves.toBe("done");
    expect(observed?.systemRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(observed?.prepareRefresh).toBeUndefined();
  } finally {
    await broker.close();
  }
});

test("Zero Risk binds a retained system refresh archive to the current request id", async () => {
  const socketPath = defaultBrokerEndpoint(join(root, "safe-broker"));
  const broker = TurnBroker.forSocket(socketPath);
  const parsed = request();
  parsed._rawBody = {
    input: [],
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: "safe-refresh-thread", turn_id: "safe-refresh-turn" }),
    },
  };
  let requestId = "";
  let archived = "";
  let fullChars = 0;
  let refreshChars = 0;
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) {
      fullChars = activity.prompt.length;
      refreshChars = activity.refreshPrompt!.length;
      requestId = JSON.parse(activity.refreshPrompt!.match(/<codex_zero_risk_request_json>\n([^\n]+)/)![1]!).request_id;
      return { tabId: "safe-tab", reused: true, promptMode: "refresh", deadlineAt: null, state: "awaiting-user" };
    },
    async waitSent() {},
    waitTerminal() {
      broker.startSafeTurn(requestId);
      return new Promise<never>(() => {});
    },
    async markStarted() {
      let index: number | null = 0;
      while (index !== null) {
        const chunk: { context: string; nextIndex: number | null } = await callTurnBroker(socketPath, {
          method: "read_context", token: requestId, contract: "safe", index, chunkChars: 512 * 1_024,
        });
        archived += chunk.context;
        index = chunk.nextIndex;
      }
      broker.completeSafeTurn(requestId, "refreshed");
    },
    async end() {},
    async cancel() {},
  };
  try {
    const start = createZeroRiskRuntimeStarter({
      provider: { adapter: "chatgpt-web", baseUrl: "manual://fixture", chatgptWeb: {
        browserInteractionMode: "manual", browserHost: "launcher",
        browserHostDescriptorPath: join(root, "manual-launcher.json"),
      } },
      broker,
      contextBroker: broker,
      capabilities: { localToolsEnabled: true, solAvailable: true, proAvailable: true },
      executionNamespace: "safe-refresh",
      control,
    });
    const runtime = start(parsed, {
      cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" }, tools: [],
    }, "safe-refresh-trace");
    await expect(runtime.browser).resolves.toBe("refreshed");
    expect(refreshChars).toBeLessThan(fullChars * 0.3);
    expect(archived).toContain("SYSTEM_SENTINEL_");
  } finally {
    await broker.close();
  }
});

test("Zero Risk refresh archive is start-bound, ordered, non-replayable, and completion-blocking", async () => {
  const socketPath = defaultBrokerEndpoint(join(root, "broker"));
  const broker = TurnBroker.forSocket(socketPath);
  const environment: ChatGptTurnEnvironment = {
    cwd: root,
    roots: [root],
    writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" },
    tools: [],
  };
  try {
    const requestId = await broker.registerSafe(environment, "surface_nonce_refresh_0123456789", 5_000, "refresh");
    await broker.registerContext(retainedSystemContextArchive([
      "first ".repeat(1_500), "second ".repeat(1_500), "third ".repeat(1_500),
    ]), 5_000, "refresh", requestId, false);
    await expect(callTurnBroker(socketPath, {
      method: "read_context", token: requestId, contract: "safe", index: 0, chunkChars: 12_000,
    })).rejects.toThrow("Sent confirmation");
    broker.confirmSafeTurnSent(requestId, "surface_nonce_refresh_0123456789");
    broker.startSafeTurn(requestId);
    const first = await callTurnBroker<{ nextIndex: number | null }>(socketPath, {
      method: "read_context", token: requestId, contract: "safe", index: 0, chunkChars: 12_000,
    });
    await expect(callTurnBroker(socketPath, {
      method: "read_context", token: requestId, contract: "safe", index: 0, chunkChars: 12_000,
    })).rejects.toThrow("replay is not allowed");
    await expect(callTurnBroker(socketPath, {
      method: "safe_complete", token: requestId, finalAnswer: "too early",
    })).rejects.toThrow("complete Codex context archive");
    let next = first.nextIndex;
    while (next !== null) {
      const chunk = await callTurnBroker<{ nextIndex: number | null }>(socketPath, {
        method: "read_context", token: requestId, contract: "safe", index: next, chunkChars: 12_000,
      });
      next = chunk.nextIndex;
    }
    expect(await callTurnBroker<{ completed: boolean; duplicate: boolean }>(socketPath, {
      method: "safe_complete", token: requestId, finalAnswer: "done",
    })).toEqual({ completed: true, duplicate: false });
  } finally {
    broker.revoke("request_missing");
    await broker.close();
  }
});

test("an incomplete archive blocks Automatic completion fences", async () => {
  const socketPath = defaultBrokerEndpoint(join(root, "completion-broker"));
  const broker = TurnBroker.forSocket(socketPath);
  const environment: ChatGptTurnEnvironment = {
    cwd: root, roots: [root], writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" }, tools: [],
  };
  try {
    const token = await broker.register(environment, 5_000, "completion-refresh");
    await broker.registerContext("updated system", 5_000, "completion-refresh", token, false);
    expect(broker.beginCompletionFence(token)).toEqual({ blocked: "context_archive", nextIndex: 0 });
    expect(broker.commitCompletionFence(token, 0)).toBe(false);
    await callTurnBroker(socketPath, { method: "read_context", token, contract: "native" });
    expect(broker.beginCompletionFence(token)).toEqual({ revision: 0 });
  } finally {
    await broker.close();
  }
});

test("a rejected archive-gated tool claim leaves no active activity", async () => {
  const socketPath = defaultBrokerEndpoint(join(root, "claim-broker"));
  const broker = TurnBroker.forSocket(socketPath);
  const environment: ChatGptTurnEnvironment = {
    cwd: root, roots: [root], writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" }, tools: [],
  };
  try {
    const token = await broker.register(environment, 5_000, "claim-refresh");
    await broker.registerContext("updated system", 5_000, "claim-refresh", token, false);
    await expect(callTurnBroker(socketPath, {
      method: "claim", token, contract: "native", activityId: "activity_archive_gated_claim_01",
    })).rejects.toThrow("complete Codex context archive");
    await callTurnBroker(socketPath, { method: "read_context", token, contract: "native" });
    expect(broker.beginCompletionFence(token)).toEqual({ revision: 0 });
  } finally {
    await broker.close();
  }
});

test("a Zero Risk archive rejects the native MCP contract", async () => {
  const socketPath = defaultBrokerEndpoint(join(root, "cross-contract-broker"));
  const broker = TurnBroker.forSocket(socketPath);
  const environment: ChatGptTurnEnvironment = {
    cwd: root, roots: [root], writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" }, tools: [],
  };
  try {
    const requestId = await broker.registerSafe(environment, "surface_nonce_contract_0123456789", 5_000, "contract");
    await broker.registerContext("updated system", 5_000, "contract", requestId, false);
    broker.confirmSafeTurnSent(requestId, "surface_nonce_contract_0123456789");
    broker.startSafeTurn(requestId);
    await expect(callTurnBroker(socketPath, {
      method: "read_context", token: requestId, contract: "native",
    })).rejects.toThrow("Zero Risk MCP contract");
  } finally {
    await broker.close();
  }
});
