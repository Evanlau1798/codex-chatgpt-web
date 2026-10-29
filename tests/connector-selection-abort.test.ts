import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_CONNECTOR_NAME } from "../src/config";
const CHATGPT_COMPOSER_SELECT_ALL_KEY = process.platform === "darwin" ? "Meta+A" : "Control+A";

test("an aborted real connector selection clears the typed mention before returning", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  let composerText = "";
  const appResult = {
    waitFor: async ({ signal }: { signal?: AbortSignal }) => {
      expect(signal).toBeDefined();
      calls.push("selection-wait");
      controller.abort();
      throw new DOMException("selection aborted", "AbortError");
    },
  };
  const menuRows = { filter: () => appResult };
  const composer = {
    fill: async (value: string, { signal }: { signal?: AbortSignal }) => {
      expect(signal).toBeDefined();
      expect(signal?.aborted).toBeFalse();
      composerText = value;
      calls.push(controller.signal.aborted ? "cleanup-fill" : "fill");
    },
    focus: async () => { calls.push("focus"); },
    press: async (key: string) => {
      calls.push(key === CHATGPT_COMPOSER_SELECT_ALL_KEY ? "cleanup-select-all" : "cleanup-backspace");
      if (key === "Backspace") composerText = "";
    },
    pressSequentially: async (value: string) => {
      composerText += value;
      calls.push("type");
    },
    evaluate: async () => { calls.push("cleanup-read"); return composerText.trim(); },
  };
  const page = {
    url: () => "https://chatgpt.com/",
    getByText: () => ({ exactConnectorLabel: true }),
    locator: (selector: string) => {
      if (selector === "body") return {
        press: async () => { calls.push("escape"); },
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
    config: { appName: "Codex Native2", useSavedChats: true },
    ensureConnectorSurface: async () => {},
    activeComposer: async () => composer,
    connectorIsSelected: async () => false,
    clearChatGptComposerState: prototype.clearChatGptComposerState,
  }, page, undefined, false, { triggerAttempts: 0 }, controller.signal);

  await expect(selection).rejects.toMatchObject({ name: "AbortError" });
  expect(composerText).toBe("");
  expect(calls).toEqual([
    "fill", "fill", "focus", "type", "selection-wait", "escape",
    "cleanup-fill", "cleanup-read", "cleanup-read",
  ]);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(composerText).toBe("");
});

test("an abort after connector activation removes the selected pill before returning", async () => {
  const controller = new AbortController();
  let composerText = "";
  let connectorSelected = false;
  const appResult = {
    waitFor: async () => {},
    count: async () => 1,
    getAttribute: async () => "",
  };
  const menuRows = { filter: () => appResult };
  const composer = {
    fill: async (value: string) => {
      composerText = value;
      if (controller.signal.aborted) connectorSelected = false;
    },
    focus: async () => {},
    pressSequentially: async (value: string) => { composerText += value; },
    press: async (key: string) => {
      if (key === "Enter") {
        connectorSelected = true;
        composerText = CHATGPT_CONNECTOR_NAME;
      } else if (key === "Backspace") {
        connectorSelected = false;
        composerText = "";
      } else {
        expect(key).toBe(CHATGPT_COMPOSER_SELECT_ALL_KEY);
      }
    },
    evaluate: async () => composerText.trim(),
  };
  const page = {
    url: () => "https://chatgpt.com/",
    getByText: () => ({ exactConnectorLabel: true }),
    locator: (selector: string) => selector === "body"
      ? { press: async () => {} }
      : menuRows,
  };
  const prototype = ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown, capture?: unknown, refresh?: boolean, budget?: unknown, signal?: AbortSignal): Promise<unknown>;
    clearChatGptComposerState(page: unknown): Promise<void>;
  };

  const selection = prototype.selectConnector.call({
    config: { appName: CHATGPT_CONNECTOR_NAME, useSavedChats: true },
    ensureConnectorSurface: async () => {},
    activeComposer: async () => composer,
    connectorIsSelected: async () => connectorSelected,
    clearChatGptComposerState: prototype.clearChatGptComposerState,
  }, page, async (checkpoint: string) => {
    if (checkpoint === "connector-choice-activated") controller.abort();
  }, false, { triggerAttempts: 0 }, controller.signal);

  await expect(selection).rejects.toMatchObject({ name: "AbortError" });
  expect(connectorSelected).toBeFalse();
  expect(composerText).toBe("");
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(connectorSelected).toBeFalse();
});
