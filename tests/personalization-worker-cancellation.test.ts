import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ensureChatGptPersonalizedConnectorAccess } from "../src/adapters/chatgpt-web/personalization";
import { ChatGptPersistentBrowserStateError } from "../src/browser-mutation";
import { CHATGPT_CONNECTOR_NAME } from "../src/config";
const CHATGPT_COMPOSER_SELECT_ALL_KEY = process.platform === "darwin" ? "Meta+A" : "Control+A";

test("a mutating stage timeout preserves a failed cleanup integrity error", async () => {
  let menuOpen = false;
  const personalized = { filter: () => personalized, count: async () => 0 };
  const unpersonalized = {
    filter: () => unpersonalized,
    count: async () => 1,
    click: async () => { menuOpen = true; },
    getAttribute: async () => "stage-timeout-menu",
  };
  const menu = {
    waitFor: async ({ signal }: { signal?: AbortSignal }) => {
      await new Promise<never>((_resolve, reject) => signal?.addEventListener(
        "abort",
        () => reject(new DOMException("menu wait aborted", "AbortError")),
        { once: true },
      ));
    },
  };
  const page = {
    getByRole: (_role: string, options: { name: string | RegExp }) => (
      (typeof options.name === "string"
        ? options.name === "Personalized"
        : options.name.test("Personalized")) ? personalized : unpersonalized
    ),
    locator: (selector: string) => selector === "body"
      ? { press: async () => { throw new Error("menu cleanup failed"); } }
      : menu,
  } as any;
  const runStage = (ChatGptBrowserWorker.prototype as unknown as {
    runStage<T>(
      traceId: string,
      stage: string,
      timeoutMs: number,
      action: (signal: AbortSignal) => Promise<T>,
      ownerSignal: AbortSignal | undefined,
      clock: { suspendedMs(): number },
      awaitAbortedActionSettlement: boolean,
    ): Promise<T>;
  }).runStage;

  await expect(runStage.call(
    {},
    "trace_cleanup_failure",
    "prompt_attachment",
    10,
    signal => ensureChatGptPersonalizedConnectorAccess(page, undefined, undefined, signal),
    undefined,
    { suspendedMs: () => 0 },
    true,
  )).rejects.toMatchObject({
    name: "ChatGptPersistentBrowserStateError",
    message: "ChatGPT labeled personalization change failed and its menu could not be closed",
  });
  expect(menuOpen).toBeTrue();
});

test("an aborted connector proof clears its mention before the preflight releases the browser page", async () => {
  const controller = new AbortController();
  const fillSignals: AbortSignal[] = [];
  const calls: string[] = [];
  const absent = {
    filter: () => absent,
    count: async () => 0,
  };
  const appResult = {
    waitFor: async ({ signal }: { signal?: AbortSignal }) => {
      expect(signal).toBeDefined();
      calls.push("proof-wait");
      controller.abort();
      throw new DOMException("proof aborted", "AbortError");
    },
  };
  const menuRows = {
    filter: () => appResult,
  };
  const composer = {
    fill: async (_value: string, { signal }: { signal?: AbortSignal }) => {
      expect(signal).toBeDefined();
      fillSignals.push(signal!);
      calls.push(controller.signal.aborted ? "cleanup-fill" : "probe-fill");
    },
    focus: async () => { calls.push("focus"); },
    press: async (key: string, { signal }: { signal?: AbortSignal }) => {
      expect(signal?.aborted).toBeFalse();
      calls.push(key === CHATGPT_COMPOSER_SELECT_ALL_KEY ? "cleanup-select-all" : "cleanup-backspace");
    },
    pressSequentially: async () => { calls.push("type"); },
    evaluate: async () => { calls.push("cleanup-read"); return ""; },
  };
  const page = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    getByRole: () => absent,
    getByText: () => ({ exactConnectorLabel: true }),
    locator: (selector: string) => {
      if (selector === "body") return {
        press: async (_key: string, { signal }: { signal?: AbortSignal }) => {
          expect(signal?.aborted).toBeFalse();
          calls.push("escape");
        },
      };
      expect(selector).toContain("__menu-item");
      return menuRows;
    },
  };
  const prototype = ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown, capture?: unknown, refresh?: boolean, budget?: unknown, signal?: AbortSignal): Promise<unknown>;
    clearChatGptComposerState(page: unknown): Promise<void>;
  };

  const selection = prototype.selectConnector.call({
    config: { appName: "Codex Native2" },
    ensureConnectorSurface: (ChatGptBrowserWorker.prototype as any).ensureConnectorSurface,
    activeComposer: async (_page: unknown, _timeout: number, signal?: AbortSignal) => {
      expect(signal).toBeDefined();
      return composer;
    },
    connectorIsSelected: async () => false,
    clearChatGptComposerState: prototype.clearChatGptComposerState,
  }, page, undefined, false, { triggerAttempts: 0 }, controller.signal);

  await expect(selection).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toEqual([
    "probe-fill", "focus", "type", "proof-wait", "escape",
    "cleanup-fill", "cleanup-read", "cleanup-read",
  ]);
  expect(fillSignals).toHaveLength(2);
  expect(fillSignals[0]?.aborted).toBeTrue();
  expect(fillSignals[1]?.aborted).toBeFalse();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(calls).toEqual([
    "probe-fill", "focus", "type", "proof-wait", "escape",
    "cleanup-fill", "cleanup-read", "cleanup-read",
  ]);
});

test("a lost connector mention cannot be used as evidence to change personalization", async () => {
  const absent = { filter: () => absent, count: async () => 0 };
  const timeout = new Error("menu absent");
  timeout.name = "TimeoutError";
  const checkpoints: string[] = [];
  let cleanupCalls = 0;
  let stateReads = 0;
  const composer = {
    fill: async () => {}, focus: async () => {}, pressSequentially: async () => {},
    evaluate: async () => ({ text: "", focused: false }),
  };
  const page = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    getByRole: () => absent,
    getByText: () => ({}),
    locator: (selector: string) => {
      if (selector.includes("__menu-item")) return { filter: () => ({ waitFor: async () => { throw timeout; } }) };
      stateReads += 1;
      throw new Error("Personalization must not be inferred from a lost input");
    },
  };
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown, capture?: (checkpoint: string) => Promise<void>): Promise<unknown>;
  }).selectConnector;
  await expect(selectConnector.call({
    config: { appName: CHATGPT_CONNECTOR_NAME },
    connectorIsSelected: async () => false,
    ensureConnectorSurface: (ChatGptBrowserWorker.prototype as any).ensureConnectorSurface,
    activeComposer: async () => composer,
    clearChatGptComposerState: async () => { cleanupCalls += 1; },
  }, page, async checkpoint => { checkpoints.push(checkpoint); })).rejects.toMatchObject({
    code: "prompt_attachment_integrity", retryable: false,
  });
  expect(cleanupCalls).toBe(1);
  expect(stateReads).toBe(0);
  expect(checkpoints).toContain("personalization-proof-menu-missing");
  expect(checkpoints).not.toContain("personalization-unpersonalized");
});
