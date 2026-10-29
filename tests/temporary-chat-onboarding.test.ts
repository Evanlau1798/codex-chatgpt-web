import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { dismissChatGptTemporaryChatOnboarding } from "../src/adapters/chatgpt-web/temporary-chat-onboarding";

test("the one-time Temporary Chat onboarding is accepted with an exact Playwright click", async () => {
  const calls: unknown[] = [];
  const button = { last: () => button, isVisible: async () => true,
    click: async (options: unknown) => { calls.push(["click", options]); } };
  const dialog = {
    filter: (options: { hasText: RegExp }) => { calls.push(["filter", options]); return dialog; },
    last: () => dialog, isVisible: async () => true,
    getByRole: (role: string, options: { name: RegExp; exact: boolean }) => {
      expect(role).toBe("button"); expect(options.exact).toBeTrue();
      for (const label of ["Continue", "Continuer"]) expect(options.name.test(label)).toBeTrue();
      for (const label of ["Continue setup", "Continuer autre chose"]) expect(options.name.test(label)).toBeFalse();
      return button;
    },
    waitFor: async (options: unknown) => { calls.push(["waitFor", options]); },
  };
  const page = { locator: (selector: string) => { expect(selector).toBe('[role="dialog"]'); return dialog; } } as unknown as Page;
  expect(await dismissChatGptTemporaryChatOnboarding(page)).toBeTrue();
  expect(calls).toContainEqual(["click", { force: true }]);
  expect(calls).toContainEqual(["waitFor", { state: "hidden", timeout: 10_000 }]);
  expect(calls.filter((call: any) => call[0] === "filter")).toHaveLength(3);
});

test("an unrelated Continue dialog is never auto-accepted", async () => {
  let lookedForButton = false;
  const dialog = { filter: () => dialog, last: () => dialog, isVisible: async () => false,
    getByRole: () => { lookedForButton = true; throw new Error("must not inspect an unrelated action"); } };
  expect(await dismissChatGptTemporaryChatOnboarding({ locator: () => dialog } as unknown as Page)).toBeFalse();
  expect(lookedForButton).toBeFalse();
});
