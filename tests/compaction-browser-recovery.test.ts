import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";

test.each([
  [true, false, true, "inline", false, false, false],
  [false, false, true, "inline", false, false, false],
  [true, true, true, "inline", false, false, false],
  [true, false, false, "inline", true, false, false],
  [true, true, false, "inline", true, false, false],
  [true, true, false, "native2-archive", false, false, false],
  [true, true, false, undefined, false, false, false],
  [true, false, false, "inline", true, true, true],
  [true, true, false, "inline", true, false, true],
] as const)("browser turns preserve recovery, ordering and final-only tools (owned=%s, tools=%s, multipart=%s, transport=%s, direct=%s, required=%s, reused=%s)", async (owned, tools, multipart, transport, direct, requiredRetained, reused) => {
  const diagnostics = mkdtempSync(join(tmpdir(), "compaction-observation-"));
  const finalResponse = new Error("fixture reached final response observation");
  const capabilities = { localToolsEnabled: tools, solAvailable: true, proAvailable: true };
  const progress = tools ? new ChatGptExternalTurnProgress() : undefined;
  const recoveryCallbacks: unknown[] = [];
  const actions: string[] = [];
  const sendBudgets: number[] = [];
  let stage = "";
  let released = false;
  let selected = false;
  const methods = ChatGptBrowserWorker.prototype as unknown as Record<string, (...args: any[]) => Promise<any>>;
  const hidden = { count: async () => 0, evaluateAll: async () => ({ count: 0 }),
    filter() { return this; }, last() { return this; }, nth() { return this; }, getByText() { return this; },
    isVisible: async () => false };
  const row = { waitFor: async () => {}, count: async () => 1, getAttribute: async () => "" };
  const page = { evaluate: async () => ({}), isClosed: () => false,
    getByText: () => ({}),
    keyboard: { press: async () => {} },
    locator: (selector: string) => selector === '.__menu-item[tabindex="0"]'
      ? { filter: () => row } : hidden,
    url: () => { actions.push("observe"); throw finalResponse; } };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { appName: "Codex Native2", browserDiagnosticsPath: diagnostics, ...(owned ? { browserHostDescriptorPath: "owned-descriptor" } : {}) },
    finalizingRuns: new Set<string>(),
    runStage: async (_trace: string, name: string, timeout: number, action: (signal: AbortSignal) => Promise<unknown>) => {
      stage = name;
      if (name === "send" || name.endsWith("_send")) sendBudgets.push(timeout);
      return action(new AbortController().signal);
    },
    prepareTemporaryChatSurface: async () => {},
    selectModelAndEffort: async (_page: unknown, model: string, effort: string) => {
      actions.push(`effort:${effort}`);
      return resolveChatGptWebModelMode(model, effort, capabilities);
    },
    activeComposer: async () => ({
      fill: async () => {}, focus: async () => {}, pressSequentially: async () => {},
      press: async () => { actions.push("connector-select"); selected = true; },
      locator: () => ({ getByTestId: () => ({
      waitFor: async () => {}, isEnabled: async () => true, press: async () => { actions.push("send"); },
    }) }) }),
    waitForSubmissionAccepted: async (...args: unknown[]) => {
      expect(args[8]).toBe(progress);
      recoveryCallbacks.push(args[10]);
      return "user_turn";
    },
    attachPrompt: async function (...args: unknown[]) {
      if (reused) return methods.attachPrompt!.apply(this, args);
      const localTools = args[2];
      expect(localTools).toBe(false);
      actions.push("attach:plain");
    },
    attachPromptWithCompactionRetry: async function (_page: unknown, _text: string, localTools: boolean, ...args: unknown[]) {
      expect(localTools).toBe((requiredRetained || tools) && !reused);
      expect(args[7]).toBe(direct);
      expect(args[8]).toBe(requiredRetained);
      if (reused) return methods.attachPromptWithCompactionRetry!.call(this, _page, _text, localTools, ...args);
      actions.push(localTools ? "attach:tools" : "attach:plain");
    },
    assertPromptAttached: async (_page: unknown, text: string) => {
      if (multipart) expect(text.endsWith("Summarize")).toBeTrue();
      else expect(text).toBe("Summarize the context");
      actions.push("verify");
    },
    ensureConnectorSurface: async () => { throw new Error("retained binding must not reopen connector discovery"); },
    selectConnector: methods.selectConnector,
    selectedConnectorControl: () => ({ waitFor: async () => {} }),
    clearChatGptComposerState: async () => {},
    insertPromptText: async (_page: unknown, text: string, _signal: unknown, _large: boolean, forceDirect: boolean) => {
      expect(selected).toBeFalse();
      expect(text).toBe("Summarize the context");
      expect(forceDirect).toBe(requiredRetained);
      actions.push("attach:retained");
    },
    connectorIsSelected: async () => { actions.push("connector-check"); return requiredRetained ? selected : true; },
    attachFiles: async () => { actions.push("files"); },
    sendAttachedPrompt: async (...args: unknown[]) => {
      // Context ingestion cannot mistake tool activity for acknowledgement of a part.
      expect(args[6]).toBeUndefined();
      if (stage !== "send") expect(args[5]).toBeUndefined();
      recoveryCallbacks.push(args[7]);
      actions.push("send");
      return "user_turn";
    },
    waitForNewAssistantTurn: async (...args: unknown[]) => {
      expect(args[5]).toBeUndefined();
      recoveryCallbacks.push(args[7]);
      actions.push("observe");
      if (stage === "send") throw finalResponse;
      return {};
    },
    waitForMultipartAcknowledgement: async () => { actions.push("ack"); },
  });
  try {
    await expect(worker.runBrowserTurn({
      traceId: "compaction_recovery_fixture",
      modelId: "gpt-5.6-sol",
      reasoning: "high",
      capabilities,
      nativeConnector: requiredRetained || reused,
      compaction: requiredRetained || !tools,
      requireRetainedConversation: requiredRetained,
      externalProgress: progress,
      completionFence: tools ? {
        begin: async () => { throw new Error("fixture must stop before completion"); },
        commit: async () => { throw new Error("fixture must stop before completion"); },
      } : undefined,
      prepare: async () => ({ text: "Summarize the context", images: [], transport, multipart: multipart ? { parts: ['{"part":1}', '{"part":2}', '{"part":3}'], commit: "Summarize" } : undefined, release: () => { released = true; } }),
    }, owned ? "owned-surface" : undefined, page, reused)).rejects.toBe(finalResponse);
    expect(recoveryCallbacks.map(callback => typeof callback)).toEqual(
      Array(multipart ? 5 : 1).fill(owned ? "function" : "undefined"),
    );
    expect(actions).toEqual([
      ...(multipart ? [
        "effort:low",
        "attach:plain", "send", "observe", "ack",
        "attach:plain", "send", "observe", "ack",
      ] : []),
      "effort:high",
      ...(reused ? ["attach:retained", "verify"]
        : [tools ? "attach:tools" : "attach:plain"]), "files", "verify",
      ...(tools && !reused ? ["connector-check"] : []),
      "send", "observe",
    ]);
    expect(sendBudgets).toEqual(multipart ? [180_000, 180_000, 180_000] : [60_000]);
    expect(released).toBe(true);
  } finally {
    rmSync(diagnostics, { recursive: true, force: true });
  }
});
