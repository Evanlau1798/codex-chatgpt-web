import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Locator, Page } from "playwright-core";
import {
  CHATGPT_PROMPT_INSERT_CHUNK_CHARS,
  ChatGptBrowserWorker,
  recoverChatGptTerminalErrorAlert,
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

test("a terminal ChatGPT error retries once inside the existing assistant turn", async () => {
  const fixture = terminalErrorScope();

  expect(await recoverChatGptTerminalErrorAlert(fixture.scope, true)).toBe(true);
  expect(fixture.pressed).toEqual(["Enter"]);
});

test("a terminal ChatGPT error fails closed when same-turn recovery is unavailable", async () => {
  const fixture = terminalErrorScope();

  await expect(recoverChatGptTerminalErrorAlert(fixture.scope, false)).rejects.toMatchObject({
    code: "upstream_server_error",
    retryable: true,
  });
  expect(fixture.pressed).toEqual([]);
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

test("terminal recovery is integrated before replay and diagnostics tolerate non-HTMLElement nodes", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");

  expect(source).toMatch(/recoverChatGptTerminalErrorAlert\(\s*responseTurn,/);
  expect(source).toContain("terminalErrorRetryUsed");
  expect(source).toContain("responseTurn = responseTurns.last()");
  expect(source).toContain('(candidate.innerText ?? candidate.textContent ?? "").trim().length');
  expect(source).toContain('(root.innerText ?? root.textContent ?? "").trim().length');
});
