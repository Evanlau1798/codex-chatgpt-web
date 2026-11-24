import { expect, test } from "bun:test";
import {
  CHATGPT_COMPOSER_SELECTOR, CHATGPT_EFFORT_MENU_SELECTOR,
  CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR, detectChatGptAccountCapabilities,
} from "../src/chatgpt-session";
import { CHATGPT_ACTIVE_EFFORT_SLIDER_SELECTOR } from "../src/chatgpt-ui/model-picker";

function picker(options: { failFirst?: boolean; staleExpanded?: boolean; missing?: boolean } = {}) {
  let expanded = !options.failFirst;
  let visible = !options.failFirst && !options.staleExpanded;
  let presses = 0;
  let escapes = 0;
  let attached = false;
  const activate = async () => { presses++; expanded = visible = !options.failFirst || presses > 1; };
  const button = {
    filter() { return this; },
    last() { return this; }, isVisible: async () => true,
    getAttribute: async (name: string) => name === "aria-expanded" ? String(expanded) : null,
    click: activate,
    dispatchEvent: activate,
  };
  const composer = { filter() { return this; }, last() { return this; },
    locator: () => ({ locator: () => button }) };
  const slider = {
    filter() { throw new Error("Do not visibility-filter the hidden semantic input"); },
    waitFor: async ({ state }: { state: string }) => {
      expect(state).toBe("attached");
      await Bun.sleep(1);
      attached = true;
    },
    getAttribute: async (name: string) => {
      expect(attached).toBeTrue();
      return ({ "aria-valuemin": "0", "aria-valuemax": "4", "aria-valuenow": "3" })[name] ?? null;
    },
  };
  const container = {
    evaluate: async () => ({
      min: "0", max: "4", value: "3",
      locks: ["false", "false", "false", "false", "false"],
    }),
    isVisible: async () => visible,
    waitFor: async ({ state }: { state: string }) => {
      expect(state).toBe("visible");
      if (options.missing || !visible) {
        throw new Error("picker remained closed");
      }
    },
    locator: (selector: string) => { expect(selector).toBe('[role="slider"]'); return slider; },
  };
  // A stale hidden sibling is last in DOM order; filtering must precede last().
  const collection = {
    last: () => { throw new Error("Unfiltered stale picker selected"); },
    filter: ({ visible }: { visible: boolean }) => {
      expect(visible).toBeTrue();
      return container;
    },
  };
  const absent = { count: async () => 0, waitFor: () => new Promise<void>(() => {}) };
  const menu = { filter() { return this; }, last() { return this; }, isVisible: async () => false,
    getByRole: () => absent, locator: () => absent };
  const page = {
    locator: (selector: string) => {
      if (selector === CHATGPT_COMPOSER_SELECTOR) return composer;
      if (selector === CHATGPT_EFFORT_MENU_SELECTOR) return menu;
      if (selector === CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR || selector === CHATGPT_ACTIVE_EFFORT_SLIDER_SELECTOR) return collection;
      throw new Error("Unexpected selector");
    },
    keyboard: { press: async () => { escapes++; expanded = visible = false; } },
  };
  return { page, presses: () => presses, escapes: () => escapes };
}

test("a visible owner hydrates its hidden semantic input without selecting the stale sibling", async () => {
  const f = picker();
  await expect(detectChatGptAccountCapabilities(f.page as never)).resolves.toEqual({ solAvailable: true, extraHighAvailable: true, proAvailable: true });
});

test("capability detection retries once when the effort picker ignores its first activation", async () => {
  const f = picker({ failFirst: true });
  await expect(detectChatGptAccountCapabilities(f.page as never)).resolves.toEqual({ solAvailable: true, extraHighAvailable: true, proAvailable: true });
  expect(f.presses()).toBe(2);
});

test("capability detection resets a hidden picker with stale expanded state", async () => {
  const f = picker({ staleExpanded: true });
  await expect(detectChatGptAccountCapabilities(f.page as never)).resolves.toEqual({ solAvailable: true, extraHighAvailable: true, proAvailable: true });
  expect(f.presses()).toBe(1);
  expect(f.escapes()).toBe(2);
});

test("missing slider fails closed instead of inferring a non-Pro account from menu rows", async () => {
  const f = picker({ missing: true });
  await expect(detectChatGptAccountCapabilities(f.page as never)).rejects.toThrow("picker remained closed");
});
