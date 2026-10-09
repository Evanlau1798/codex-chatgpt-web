import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptBrowserTabClosedError } from "../src/adapters/chatgpt-web/adapter-error";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { CHATGPT_USER_TURN_SELECTOR, CHATGPT_ASSISTANT_TURN_SELECTOR } from "../src/chatgpt-session";

test.each([
  [true, false, true, "inline", false, false, false, false, false, false],
  [false, false, true, "inline", false, false, false, false, false, false],
  [true, true, true, "inline", false, false, false, false, false, false],
  [true, false, false, "inline", true, false, false, false, false, false],
  [true, true, false, "inline", true, false, false, false, false, false],
  [true, true, false, "native2-archive", false, false, false, false, false, false],
  [true, true, false, undefined, false, false, false, false, false, false],
  [true, false, false, "inline", true, true, true, false, false, false],
  [true, true, false, "inline", true, false, true, false, false, false],
  [true, false, true, "inline", false, false, false, true, false, false],
  [true, false, true, "inline", false, false, false, true, true, false],
  [true, false, true, "inline", false, false, false, false, false, true],
] as const)("browser turns preserve recovery, ordering and final-only tools (owned=%s, tools=%s, multipart=%s, transport=%s, direct=%s, required=%s, reused=%s, size rejected=%s, SSE=%s, GPT6 Pro=%s)", async (owned, tools, multipart, transport, direct, requiredRetained, reused, sizeRejected = false, sseRejection = false, gpt6Pro = false) => {
  const diagnostics = mkdtempSync(join(tmpdir(), "compaction-observation-"));
  const cancellationCase = owned && !tools && !multipart;
  const effort = gpt6Pro ? "max" : tools ? "xhigh" : "high";
  const finalResponse = cancellationCase ? chatGptBrowserTabClosedError() : new Error("fixture reached final response observation");
  const capabilities = { localToolsEnabled: tools, solAvailable: true, extraHighAvailable: true, proAvailable: true };
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
  let activated = 0;
  let finalSent = false;
  const remountHistory = owned && !tools && multipart;
  let historyRemounted = false;
  const users = () => remountHistory ? [...(historyRemounted ? ["older-user"] : []), "old-user"] : [];
  const assistants = () => remountHistory ? [...(historyRemounted ? ["older-assistant"] : []), "old-assistant"] : [];
  const history = () => remountHistory ? [...(historyRemounted ? ["older-user", "older-assistant"] : []), "old-user", "old-assistant"] : [];
  const responseTurns = { ...hidden, page: () => page,
    evaluateAll: async () => ({ count: assistants().length, identities: assistants(), ambiguous: false }) };
  let freshChatPreparations = 0;
  let rejectionAbortedWait = false;
  const frame = {};
  const page = Object.assign(new EventEmitter(), { mainFrame: () => frame, evaluate: async () => ({}), isClosed: () => false,
    getByText: () => ({}),
    keyboard: { press: async () => {} },
    locator: (selector: string) => selector === CHATGPT_USER_TURN_SELECTOR
      ? { ...hidden, count: async () => users().length, evaluateAll: async () => users() }
      : selector === CHATGPT_ASSISTANT_TURN_SELECTOR ? responseTurns
      : selector === "[data-turn-id-container], [data-turn-key]" ? { evaluateAll: async () => history() }
      : selector.includes('.__menu-item[tabindex="0"]') ? { filter: () => row } : hidden,
    url: () => {
      if (stage === "send" && finalSent) { actions.push("observe"); throw finalResponse; }
      return "https://chatgpt.com/?temporary-chat=true";
    } });
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { appName: "Codex Native2", browserDiagnosticsPath: diagnostics, ...(owned ? { browserHostDescriptorPath: "owned-descriptor" } : {}) },
    finalizingRuns: new Set<string>(),
    runStage: async (_trace: string, name: string, timeout: number, action: (signal: AbortSignal) => Promise<unknown>) => {
      stage = name;
      if (name === "send" || name.endsWith("_send")) sendBudgets.push(timeout);
      const result = await action(new AbortController().signal);
      if (remountHistory && name === "multipart_stage_1_attachment") historyRemounted = true;
      return result;
    },
    prepareChatSurface: async () => { freshChatPreparations += 1; },
    assertSelectedEffort: async () => {},
    selectModelAndEffort: async (_page: unknown, model: string, effort: string, _capabilities: unknown,
      _diagnostic: unknown, trackUsage: boolean, family: string) => {
      expect(trackUsage).toBe(false);
      expect(family).toBe(gpt6Pro && effort === "max" ? "6" : "5.6");
      actions.push(`effort:${effort}`);
      return resolveChatGptWebModelMode(model, effort, capabilities);
    },
    activeComposer: async () => ({
      fill: async () => {}, focus: async () => {}, pressSequentially: async () => {},
      press: async () => { actions.push("connector-select"); selected = true; },
      locator: () => ({ locator: () => ({
      waitFor: async () => {}, isEnabled: async () => true, press: async () => {
        finalSent = true;
        actions.push("send");
        if (cancellationCase) {
          const request = { method: () => "POST", url: () => "https://chatgpt.com/backend-api/f/conversation", frame: () => frame };
          page.emit("request", request);
          page.emit("response", { request: () => request, status: () => 413,
            headers: () => ({ "content-type": "application/json" }),
            json: async () => ({ detail: { code: "message_length_exceeds_limit" } }),
          });
          throw finalResponse;
        }
      },
    }) }) }),
    waitForSubmissionAccepted: async (...args: unknown[]) => {
      expect(args[8]).toBe(progress);
      recoveryCallbacks.push(args[11]);
      return "user_turn";
    },
    attachPrompt: async function (...args: unknown[]) {
      if (reused) return methods.attachPrompt!.apply(this, args);
      const localTools = args[2];
      expect(localTools).toBe(false);
      actions.push("attach:plain");
    },
    attachPromptWithCompactionRetry: async function (_page: unknown, _text: string, localTools: boolean, ...args: unknown[]) {
      expect(localTools).toBe(requiredRetained || tools || reused);
      expect(args[7]).toBe(direct || multipart);
      expect(args[8]).toBe(requiredRetained);
      if (reused) return methods.attachPromptWithCompactionRetry!.call(this, _page, _text, localTools, ...args);
      actions.push(localTools ? "attach:tools" : "attach:plain");
    },
    assertPromptAttached: async (_page: unknown, text: string) => {
      if (multipart) expect(text.endsWith("Summarize")).toBeTrue();
      else expect(text).toBe((requiredRetained || tools || reused)
        ? " Summarize the context" : "Summarize the context");
      actions.push("verify");
    },
    ensureConnectorSurface: async () => {},
    selectConnector: async () => { selected = true; actions.push("connector-select"); return worker.activeComposer(); },
    selectedConnectorControl: () => ({ waitFor: async () => {} }),
    clearChatGptComposerState: async () => {},
    insertPromptText: async (_page: unknown, text: string, _signal: unknown, _large: boolean, forceDirect: boolean) => {
      expect(selected).toBeTrue();
      expect(text).toBe(" Summarize the context");
      expect(forceDirect).toBe(requiredRetained);
      actions.push("attach:retained");
    },
    connectorIsSelected: async () => { actions.push("connector-check"); return requiredRetained ? selected : true; },
    attachFiles: async () => { actions.push("files"); },
    sendAttachedPrompt: async (...args: unknown[]) => {
      await (args[5] as () => Promise<void>)();
      (args[1] as { activateSubmissionRequestObservation(): void }).activateSubmissionRequestObservation();
      if (sizeRejected && stage === "multipart_stage_2_send") {
        const request = { method: () => "POST", url: () => "https://chatgpt.com/backend-api/f/conversation", frame: () => frame };
        page.emit("request", request);
        page.emit("response", { request: () => request, status: () => sseRejection ? 200 : 413,
          headers: () => ({ "content-type": sseRejection ? "text/event-stream" : "application/json" }),
          json: async () => ({ detail: { code: "message_length_exceeds_limit" } }),
          text: async () => 'data: {"error":"The message you submitted was too long, please edit it and resubmit.","error_code":"input_too_large","error_reason":"last_user_message"}\n\ndata: [DONE]\n\n',
        });
        page.emit("requestfinished", request);
      }
      if (remountHistory) {
        expect((args[1] as { initialTurnIdentities: string[] }).initialTurnIdentities).toContain("older-user");
        expect((args[1] as { initialResponseTurn: { count: number } }).initialResponseTurn.count).toBe(2);
      }
      // Context ingestion cannot mistake tool activity for acknowledgement of a part.
      expect(args[6]).toBeUndefined();
      recoveryCallbacks.push(args[7]);
      actions.push("send");
      return "user_turn";
    },
    waitForNewAssistantTurn: async (...args: unknown[]) => {
      if (remountHistory) expect((args[1] as { initialResponseTurn: { count: number } }).initialResponseTurn.count).toBe(2);
      expect(args[4]).toBeUndefined();
      recoveryCallbacks.push(args[6]);
      actions.push("observe");
      if (stage === "send") throw finalResponse;
      if (sizeRejected && stage === "multipart_stage_2_acknowledgement") {
        const signal = args[3] as AbortSignal;
        await new Promise((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("rejected stage kept waiting")), 250);
          const onAbort = () => { clearTimeout(timer); rejectionAbortedWait = true; reject(signal.reason); };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      return {};
    },
    waitForMultipartAcknowledgement: async () => { actions.push("ack"); return { identity: `stage:${actions.length}` }; },
  });
  try {
    const run = worker.runBrowserTurn({
      traceId: "compaction_recovery_fixture",
      modelId: "gpt-5.6-sol",
      modelFamily: gpt6Pro ? "6" : "5.6",
      reasoning: effort,
      onSendActivated: () => { activated += 1; },
      capabilities,
      nativeConnector: requiredRetained || reused,
      compaction: requiredRetained || !tools,
      requireRetainedConversation: requiredRetained,
      externalProgress: progress,
      completionFence: tools ? {
        begin: async () => { throw new Error("fixture must stop before completion"); },
        commit: async () => { throw new Error("fixture must stop before completion"); },
      } : undefined,
      prepare: async () => ({ text: "Summarize the context", images: [], transport, multipart: multipart ? { parts: Array.from({ length: 6 }, (_, index) => JSON.stringify({ part: index + 1 })), commit: "Summarize" } : undefined, release: () => { released = true; } }),
    }, owned ? "owned-surface" : undefined, page, reused);
    if (sizeRejected) {
      await expect(run).rejects.toMatchObject({ code: "context_length_exceeded", retryable: false });
      expect(rejectionAbortedWait).toBeTrue();
      expect(sendBudgets).toHaveLength(2);
      expect(actions.filter(action => action === "ack")).toHaveLength(1);
      expect(released).toBeTrue();
      expect(page.listenerCount("request")).toBe(0);
      expect(page.listenerCount("response")).toBe(0);
      expect(page.listenerCount("requestfinished")).toBe(0);
      expect(page.listenerCount("requestfailed")).toBe(0);
      return;
    }
    await expect(run).rejects.toBe(finalResponse);
    expect(freshChatPreparations).toBe(reused ? 0 : 1);
    if (cancellationCase) {
      expect(actions.filter(action => action === "send")).toHaveLength(1);
      expect(actions).not.toContain("observe");
      expect(released).toBeTrue();
      expect(activated).toBe(1);
      expect(page.listenerCount("request")).toBe(0);
      expect(page.listenerCount("response")).toBe(0);
      return;
    }
    expect(recoveryCallbacks.map(callback => typeof callback)).toEqual(
      Array(multipart ? 11 : 1).fill(owned ? "function" : "undefined"),
    );
    expect(actions).toEqual([
      ...(multipart ? [
        "effort:low",
        ...Array.from({ length: 5 }, (_, index) => [
          ...(index > 0 ? ["effort:low"] : []), "attach:plain", "send", "observe", "ack",
        ]).flat(),
      ] : []),
      `effort:${effort}`,
      ...(reused ? ["connector-select", "attach:retained", "verify"]
        : [tools ? "attach:tools" : "attach:plain"]), "files", "verify",
      ...((requiredRetained || tools || reused) ? ["connector-check"] : []),
      "send", "observe",
    ]);
    expect(sendBudgets).toEqual(multipart ? Array(6).fill(180_000) : [60_000]);
    expect(released).toBe(true);
    expect(activated).toBe(1);
    expect(page.listenerCount("request")).toBe(0);
    expect(page.listenerCount("response")).toBe(0);
  } finally {
    rmSync(diagnostics, { recursive: true, force: true });
  }
});
