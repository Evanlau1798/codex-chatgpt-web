import { expect, test } from "bun:test";
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_ITEM_SELECTOR,
  CHATGPT_EFFORT_MENU_SELECTOR,
  CHATGPT_EFFORT_SLIDER_SELECTOR,
  detectChatGptAccountCapabilities,
} from "../src/chatgpt-session";

test("effort selectors cover the current semantic slider DOM", () => {
  expect(CHATGPT_EFFORT_CONTROL_SELECTOR.split(", ")).toContain(
    'button[data-tone="neutral"][aria-haspopup="menu"]',
  );
  expect(CHATGPT_EFFORT_SLIDER_SELECTOR.split(", ")).toContain(
    '[data-testid="composer-intelligence-picker-content"] [role="slider"]',
  );
});

test("capability detection accepts a semantic effort slider with no visible box", async () => {
  const effortButton = {
    last() { return this; },
    isVisible: async () => true,
    getAttribute: async () => "true",
  };
  const composerForm = {
    locator: (selector: string) => {
      expect(selector).toBe(CHATGPT_EFFORT_CONTROL_SELECTOR);
      return effortButton;
    },
  };
  const composers = {
    filter() { return this; },
    last() { return this; },
    locator: () => composerForm,
  };
  const efforts = {
    first: () => ({ waitFor: async () => {} }),
    count: async () => 2,
  };
  const menu = {
    last() { return this; },
    isVisible: async () => true,
    locator: (selector: string) => {
      expect(selector).toBe(CHATGPT_EFFORT_ITEM_SELECTOR);
      return efforts;
    },
  };
  const slider = {
    count: async () => 1,
    waitFor: async ({ state }: { state: string }) => expect(state).toBe("attached"),
    getAttribute: async (name: string) => ({
      "aria-valuemin": "0",
      "aria-valuemax": "4",
      "aria-valuenow": "3",
    })[name as "aria-valuemin" | "aria-valuemax" | "aria-valuenow"],
  };
  const sliderCollection = {
    filter() { throw new Error("semantic effort sliders may be visually hidden"); },
    last: () => slider,
  };
  const page = {
    locator: (selector: string) => {
      if (selector === CHATGPT_COMPOSER_SELECTOR) return composers;
      if (selector === CHATGPT_EFFORT_MENU_SELECTOR) return menu;
      if (selector === CHATGPT_EFFORT_SLIDER_SELECTOR) return sliderCollection;
      throw new Error(`Unexpected selector: ${selector}`);
    },
    keyboard: { press: async () => {} },
  };

  await expect(detectChatGptAccountCapabilities(page as never)).resolves.toEqual({
    solAvailable: true,
    proAvailable: true,
  });
});
