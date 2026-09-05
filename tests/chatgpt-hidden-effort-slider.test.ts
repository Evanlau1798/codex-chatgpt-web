import { expect, test } from "bun:test";
import {
  CHATGPT_COMPOSER_SELECTOR, CHATGPT_EFFORT_MENU_SELECTOR,
  CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR, detectChatGptAccountCapabilities,
} from "../src/chatgpt-session";

function picker(options: { failFirst?: boolean; staleExpanded?: boolean; missing?: boolean } = {}) {
  let expanded = !options.failFirst;
  let presses = 0;
  let escapes = 0;
  let attached = false;
  let waits = 0;
  const button = {
    last() { return this; }, isVisible: async () => true,
    getAttribute: async () => String(options.staleExpanded || expanded),
    press: async () => { presses++; expanded = true; },
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
    isVisible: async () => true,
    waitFor: async ({ state }: { state: string }) => {
      expect(state).toBe("visible");
      waits++;
      if (options.missing || (options.failFirst && waits === 1) || (options.staleExpanded && presses === 0)) {
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
      return { last: () => container };
    },
  };
  const menu = { filter() { return this; }, last() { return this; }, isVisible: async () => false };
  const page = {
    locator: (selector: string) => {
      if (selector === CHATGPT_COMPOSER_SELECTOR) return composer;
      if (selector === CHATGPT_EFFORT_MENU_SELECTOR) return menu;
      if (selector === CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR) return collection;
      throw new Error("Unexpected selector");
    },
    keyboard: { press: async () => { escapes++; expanded = false; } },
  };
  return { page, presses: () => presses, escapes: () => escapes };
}

test("a visible owner hydrates its hidden semantic input without selecting the stale sibling", async () => {
  const f = picker();
  await expect(detectChatGptAccountCapabilities(f.page as never)).resolves.toEqual({ solAvailable: true, proAvailable: true });
});

test("capability detection retries once when the effort picker ignores its first activation", async () => {
  const f = picker({ failFirst: true });
  await expect(detectChatGptAccountCapabilities(f.page as never)).resolves.toEqual({ solAvailable: true, proAvailable: true });
  expect(f.presses()).toBe(2);
});

test("capability detection resets a hidden picker with stale expanded state", async () => {
  const f = picker({ staleExpanded: true });
  await expect(detectChatGptAccountCapabilities(f.page as never)).resolves.toEqual({ solAvailable: true, proAvailable: true });
  expect(f.presses()).toBe(1);
  expect(f.escapes()).toBe(2);
});

test("missing slider fails closed instead of inferring a non-Pro account from menu rows", async () => {
  const f = picker({ missing: true });
  await expect(detectChatGptAccountCapabilities(f.page as never)).rejects.toThrow("picker remained closed");
});
