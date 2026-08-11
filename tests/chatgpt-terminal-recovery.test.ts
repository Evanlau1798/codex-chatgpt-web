import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Locator, Page } from "playwright-core";
import {
  CHATGPT_PROMPT_INSERT_CHUNK_CHARS,
  ChatGptBrowserWorker,
  chatGptTerminalErrorRetryPrompt,
  throwIfChatGptTerminalErrorAlert,
} from "../src/adapters/chatgpt-web/browser-worker";

function terminalErrorScope() {
  let visible = true;
  const pressed: string[] = [];
  const alert = {
    last: () => alert,
    isVisible: async () => visible,
    waitFor: async ({ state }: { state: string }) => {
      expect(state).toBe("hidden");
      visible = false;
    },
  };
  const retry = {
    last: () => retry,
    isVisible: async () => visible,
    press: async (key: string) => {
      pressed.push(key);
      visible = false;
    },
  };
  return {
    scope: {
      getByText: () => alert,
      getByRole: () => retry,
    } as unknown as Locator,
    pressed,
  };
}

test("a terminal ChatGPT error continues once without pressing the Web retry button", async () => {
  const fixture = terminalErrorScope();
  let failure: Error | undefined;

  try {
    await throwIfChatGptTerminalErrorAlert(fixture.scope);
  } catch (error) {
    failure = error as Error;
  }
  expect(failure).toMatchObject({ code: "upstream_server_error", retryable: true });
  expect(fixture.pressed).toEqual([]);
  expect(chatGptTerminalErrorRetryPrompt(failure!, 1, "")).toContain("Do not repeat completed tool calls");
  expect(chatGptTerminalErrorRetryPrompt(failure!, 2, "")).toBeUndefined();
  expect(chatGptTerminalErrorRetryPrompt(failure!, 1, "partial answer")).toBeUndefined();
});

test("a visible completed answer wins over a stale terminal error banner", async () => {
  const fixture = terminalErrorScope();
  await expect(throwIfChatGptTerminalErrorAlert(fixture.scope, true)).resolves.toBeUndefined();
});

test("a long prompt retries as one edit when a later Lexical chunk rewrites committed text", async () => {
  const prompt = "x".repeat(CHATGPT_PROMPT_INSERT_CHUNK_CHARS + 7_506);
  const calls: Array<[string, string?]> = [];
  let assertions = 0;
  const composer = {
    fill: async (value: string) => { calls.push(["fill", value]); },
    focus: async () => { calls.push(["focus"]); },
  };
  const page = {
    keyboard: {
      insertText: async (value: string) => { calls.push(["insertText", value]); },
    },
  } as unknown as Page;
  const attachPrompt = (ChatGptBrowserWorker.prototype as unknown as {
    attachPrompt(page: Page, prompt: string, localTools: boolean): Promise<void>;
  }).attachPrompt;
  const insertPromptText = (ChatGptBrowserWorker.prototype as unknown as {
    insertPromptText(page: Page, text: string): Promise<void>;
  }).insertPromptText;

  await attachPrompt.call({
    activeComposer: async () => composer,
    insertPromptText,
    waitForPromptChunkAttached: async () => {},
    assertPromptAttached: async () => {
      assertions += 1;
      if (assertions === 1) throw new Error("Lexical rewrote the first chunk");
    },
  }, page, prompt, false);

  expect(calls.filter(([name]) => name === "fill")).toHaveLength(2);
  expect(calls.filter(([name]) => name === "insertText").map(([, value]) => value?.length)).toEqual([
    CHATGPT_PROMPT_INSERT_CHUNK_CHARS,
    7_506,
    prompt.length,
  ]);
  expect(assertions).toBe(2);
});

test("a long tool prompt reselects its connector before the single-edit retry", async () => {
  const prompt = "x".repeat(CHATGPT_PROMPT_INSERT_CHUNK_CHARS + 1);
  let selections = 0;
  let assertions = 0;
  const inserted: string[] = [];
  const composer = { focus: async () => {} };
  const page = {
    keyboard: {
      press: async () => {},
      insertText: async (value: string) => { inserted.push(value); },
    },
  } as unknown as Page;
  const attachPrompt = (ChatGptBrowserWorker.prototype as unknown as {
    attachPrompt(page: Page, prompt: string, localTools: boolean): Promise<void>;
  }).attachPrompt;

  await attachPrompt.call({
    selectConnector: async () => {
      selections += 1;
      return composer;
    },
    insertPromptText: async () => {},
    assertPromptAttached: async () => {
      assertions += 1;
      if (assertions === 1) throw new Error("Lexical rewrote the first chunk");
    },
  }, page, prompt, true);

  expect(selections).toBe(2);
  expect(inserted).toEqual([` ${prompt}`]);
});

test("terminal recovery is integrated as a same-conversation continuation", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");

  expect(source).toContain("chatGptTerminalErrorRetryPrompt(failure, responseAttempt, emittedText)");
  expect(source).not.toContain("terminalErrorRetryUsed");
  expect(source).toContain('(candidate.innerText ?? candidate.textContent ?? "").trim().length');
  expect(source).toContain('(root.innerText ?? root.textContent ?? "").trim().length');
});
