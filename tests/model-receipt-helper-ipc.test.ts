import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import type { BrowserTurn, ResolvedBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import {
  assertChatGptModelReceipt,
  type ChatGptModelReceipt,
  type ChatGptModelReceiptDiagnostic,
} from "../src/adapters/chatgpt-web/model-receipt";
import { parseLauncherHelperMessage } from "../src/adapters/chatgpt-web/launcher-helper-protocol";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function receipt(): ChatGptModelReceipt {
  return {
    kind: "chatgpt_model_receipt",
    version: 1,
    traceId: "helper-receipt-123",
    physicalSend: 1,
    responseAttempt: 1,
    provenance: "initial",
    requestedModel: "chatgpt-web/gpt-6-pro",
    backendContextModel: "gpt-5.6-sol",
    browserRequestModel: "gpt-6-pro",
    servedModel: "gpt-6-pro",
    source: "network.resolved_model_slug",
    defaultModelSlug: "gpt-6-auto-thinking",
    requestedModelSlug: "gpt-6-pro-thinking",
    modelSlug: "gpt-6-pro-thinking",
    conversationIdHash: "a".repeat(24),
    messageIdHash: "b".repeat(24),
  };
}

function diagnostic(): ChatGptModelReceiptDiagnostic {
  return {
    kind: "chatgpt_model_receipt_diagnostic",
    version: 1,
    traceId: "helper-receipt-123",
    physicalSend: 1,
    responseAttempt: 1,
    provenance: "initial",
    outcome: "resolved",
    reason: "receipt_emitted",
    ownedRequests: 1,
    cdpCaptures: 1,
    terminalCaptures: 1,
  };
}

test("helper receipt protocol accepts only the bounded provider-private shape", () => {
  const value = receipt();
  expect(parseLauncherHelperMessage(JSON.stringify({
    type: "event", id: value.traceId, event: "model_receipt", receipt: value,
  }))).toMatchObject({ type: "event", event: "model_receipt", receipt: value });
  expect(parseLauncherHelperMessage(JSON.stringify({
    type: "event", id: value.traceId, event: "model_receipt_diagnostic", diagnostic: diagnostic(),
  }))).toMatchObject({ type: "event", event: "model_receipt_diagnostic", diagnostic: diagnostic() });
  expect(() => parseLauncherHelperMessage(JSON.stringify({
    type: "event", id: value.traceId, event: "model_receipt", receipt: { ...value, traceId: "other-trace-123" },
  }))).toThrow("trace");
  expect(() => parseLauncherHelperMessage(JSON.stringify({
    type: "event", id: value.traceId, event: "model_receipt_diagnostic", diagnostic: { ...diagnostic(), traceId: "other-trace-123" },
  }))).toThrow("trace");
  expect(() => parseLauncherHelperMessage(JSON.stringify({
    type: "event", id: value.traceId, event: "model_receipt", receipt: { ...value, prompt: "no" }, prompt: "no",
  }))).toThrow("unsupported field");
  expect(() => parseLauncherHelperMessage(JSON.stringify({
    type: "event", id: value.traceId, event: "model_receipt_diagnostic", diagnostic: { ...diagnostic(), ownedRequests: 33 },
  }))).toThrow();
  expect(() => assertChatGptModelReceipt({ ...value, prompt: "do not carry me" })).toThrow("unsupported field");
  expect(() => assertChatGptModelReceipt({ ...value, authorization: "Bearer secret" })).toThrow("unsupported field");
  expect(() => assertChatGptModelReceipt({ ...value, requestedModel: "x".repeat(161) })).toThrow();
  expect(() => parseLauncherHelperMessage(JSON.stringify({
    type: "event", id: value.traceId, event: "model_receipt", receipt: { ...value, cookie: "session" },
  }))).toThrow("unsupported field");
  expect(() => parseLauncherHelperMessage(JSON.stringify({
    type: "event", id: value.traceId, event: "model_receipt_diagnostic", diagnostic: { ...diagnostic(), prompt: "no" },
  }))).toThrow("unsupported field");
  expect(() => parseLauncherHelperMessage(JSON.stringify({
    type: "event", id: value.traceId, event: "unknown", receipt: value,
  }))).toThrow("unknown event");
});

test("real helper boundary replays run fields through worker event and daemon callback", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-model-receipt-helper-"));
  roots.push(root);
  const helper = join(root, "receipt-helper.ts");
  writeFileSync(helper, `
    import { ChatGptBrowserWorker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
    ChatGptBrowserWorker.prototype.run = async function(turn) {
      if (turn.requestedModel !== "chatgpt-web/gpt-6-pro" || turn.backendContextModel !== "gpt-5.6-sol") {
        throw new Error("receipt route fields were not transported");
      }
      turn.onModelReceipt?.({ ...${JSON.stringify(receipt())}, ...(turn.modelReceiptProvenance === "surface_recovery" ? { traceId: "other-trace-123" } : {}) });
      turn.onModelReceiptDiagnostic?.(${JSON.stringify(diagnostic())});
      return "READY";
    };
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `, { mode: 0o700 });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 3,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:39101",
    control: { endpoint: "http://127.0.0.1:39102", token: "launcher-control-token-0123456789abcdefghijklmnop" },
    helper: { executable: process.execPath, script: helper },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_receipt_1234567",
    surfaceTargets: { launcher_surface_receipt_1234567: "native-owned-target" },
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const config: ResolvedBrowserConfig = {
    appName: "Codex Receipt Test",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    browserHelperScriptPath: helper,
    storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000,
    headed: false,
    autoApproveToolCalls: false,
    useSavedChats: false,
  };
  const received: ChatGptModelReceipt[] = [];
  const diagnostics: ChatGptModelReceiptDiagnostic[] = [];
  const client = new LauncherBrowserHelperClient(config);
  try {
    const result = await client.run({
      traceId: receipt().traceId,
      modelId: "gpt-5.6-sol",
      requestedModel: "chatgpt-web/gpt-6-pro",
      backendContextModel: "gpt-5.6-sol",
      capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
      prepare: async () => ({ text: "offline fixture", images: [], release() {} }),
      onTextDelta() {},
      onModelReceipt: value => received.push(value),
      onModelReceiptDiagnostic: value => diagnostics.push(value),
    } as BrowserTurn);
    expect(result).toBe("READY");
    expect(received).toEqual([receipt()]);
    expect(diagnostics).toEqual([diagnostic()]);
    expect(JSON.stringify(received)).not.toContain("prompt");
    expect(JSON.stringify(received)).not.toContain("authorization");
    expect(JSON.stringify(received)).not.toContain("cookie");
    expect(JSON.stringify(received)).not.toContain("toolNames");
    await expect(client.run({
      traceId: "helper-receipt-bad",
      modelId: "gpt-5.6-sol",
      requestedModel: "chatgpt-web/gpt-6-pro",
      backendContextModel: "gpt-5.6-sol",
      modelReceiptProvenance: "surface_recovery",
      capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
      prepare: async () => ({ text: "offline fixture", images: [], release() {} }),
      onTextDelta() {},
      onModelReceipt: value => received.push(value),
    } as BrowserTurn)).rejects.toThrow("trace");
  } finally {
    await client.close();
  }
});
