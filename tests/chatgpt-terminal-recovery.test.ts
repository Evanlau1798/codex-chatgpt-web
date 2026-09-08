import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Locator } from "playwright-core";
import {
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
      getByTestId: () => ({ last: () => ({ isVisible: async () => false }) }),
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

test("a localized short current-response error button fails the turn", async () => {
  const hidden = { last: () => ({ isVisible: async () => false }) };
  const visible = { last: () => ({ isVisible: async () => true }) };
  const scope = {
    getByText: () => hidden,
    getByTestId: (id: string) => id === "regenerate-thread-error-button" ? visible : hidden,
  } as unknown as Locator;
  await expect(throwIfChatGptTerminalErrorAlert(scope)).rejects.toMatchObject({
    code: "upstream_server_error", retryable: true,
  });
});

test("a visible completed answer wins over a stale terminal error banner", async () => {
  const fixture = terminalErrorScope();
  await expect(throwIfChatGptTerminalErrorAlert(fixture.scope, true)).resolves.toBeUndefined();
});

test("terminal recovery is integrated as a same-conversation continuation", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");

  expect(source).toContain("chatGptTerminalErrorRetryPrompt(failure, responseAttempt, answerBuffer.value())");
  expect(source).not.toContain("terminalErrorRetryUsed");
  expect(source).toContain('(candidate.innerText ?? candidate.textContent ?? "").trim().length');
  expect(source).toContain('(root.innerText ?? root.textContent ?? "").trim().length');
});
