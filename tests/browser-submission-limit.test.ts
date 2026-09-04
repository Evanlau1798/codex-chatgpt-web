import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

function dialogPage(text: string, buttonText = "Got it"): { page: Page; pressed: string[] } {
  const pressed: string[] = [];
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
          || (typeof name === "string" ? buttonText === name : name.test(buttonText));
        return button;
      },
    };
    return dialog;
  };
  return {
    page: {
      locator: () => createDialog(),
      getByText: (hasText: string | RegExp) => createDialog().filter({ hasText }),
    } as unknown as Page,
    pressed,
  };
}

test("submission acceptance reports a rate-limit dialog that appears after Enter", async () => {
  const fixture = dialogPage("Too many requests. You're making requests too quickly.");
  const waitForSubmissionAccepted = (ChatGptBrowserWorker.prototype as unknown as {
    waitForSubmissionAccepted(page: Page, baseline: unknown): Promise<unknown>;
  }).waitForSubmissionAccepted;

  await expect(waitForSubmissionAccepted.call(
    {},
    fixture.page,
    {},
  )).rejects.toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: false,
    retireSession: true,
  });
  expect(fixture.pressed).toEqual(["Enter"]);
});


test("submission evidence is logged before waiting for projected response content", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const run = source.slice(source.indexOf("  private async runBrowserTurn("));
  const multipartSend = run.indexOf("const evidence = await this.runStage(");
  const multipartAccepted = run.indexOf("submission accepted evidence=${evidence}", multipartSend);
  const multipartResponse = run.indexOf("const responseTurn = await this.waitForNewAssistantTurn(", multipartSend);
  expect(multipartSend).toBeGreaterThan(-1);
  expect(multipartAccepted).toBeGreaterThan(multipartSend);
  expect(multipartResponse).toBeGreaterThan(multipartAccepted);
  const finalSend = run.indexOf("await activateChatGptSendControl(");
  const finalAccepted = run.indexOf("submission accepted evidence=${evidence}", finalSend);
  const finalResponse = run.indexOf("let lastHeartbeat", finalSend);
  expect(finalSend).toBeGreaterThan(-1);
  expect(finalAccepted).toBeGreaterThan(finalSend);
  expect(finalResponse).toBeGreaterThan(finalAccepted);
});
