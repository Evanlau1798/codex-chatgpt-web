import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { throwIfChatGptRateLimitDialog } from "../src/adapters/chatgpt-web/browser-worker";

test("the Japanese ChatGPT rate-limit dialog returns the structured 429", async () => {
  const pressed: string[] = [];
  const text = "リクエストが多すぎます。リクエストの頻度が高すぎます。";
  const createDialog = () => {
    let matches = true;
    let buttonMatches = true;
    const button = {
      last: () => button,
      isVisible: async () => matches && buttonMatches,
      press: async (key: string) => { pressed.push(key); },
    };
    const dialog = {
      filter: ({ hasText }: { hasText: string | RegExp }) => {
        matches &&= typeof hasText === "string" ? text.includes(hasText) : hasText.test(text);
        return dialog;
      },
      last: () => dialog,
      isVisible: async () => matches,
      getByRole: (_role: string, options?: { name?: string | RegExp }) => {
        const name = options?.name;
        buttonMatches = name === undefined
          || (typeof name === "string" ? name === "了解" : name.test("了解"));
        return button;
      },
    };
    return dialog;
  };
  const page = { locator: () => createDialog() } as unknown as Page;

  await expect(throwIfChatGptRateLimitDialog(page)).rejects.toMatchObject({
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: false,
    retireSession: true,
  });
  expect(pressed).toEqual(["Enter"]);
});
