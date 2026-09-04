import { expect, test } from "bun:test";
import {
  activateChatGptEffortMenu, CHATGPT_EFFORT_MENU_SELECTOR, CHATGPT_EFFORT_SLIDER_SELECTOR,
} from "../src/chatgpt-session";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

function fixture(openWith: "click" | "pointerdown" | "none" | "hidden-slider") {
  let opened = false;
  let expanded = false;
  const events: string[] = [];
  const clickOptions: unknown[] = [];
  const hidden = {
    filter() { return this; }, last() { return this; },
    isVisible: async () => false, count: async () => 0,
    waitFor: async () => { throw new Error("surface missing"); },
  };
  const hiddenAlert = { ...hidden, waitFor: () => new Promise<void>(() => {}) };
  const modelChoice = { waitFor: async () => {}, getAttribute: async () => "true" };
  const owned = {
    isVisible: async () => opened,
    locator: () => ({ nth: () => modelChoice, count: async () => 5 }),
  };
  const stale = {
    ...hidden,
    locator: () => ({ nth: () => ({ waitFor: async () => { throw new Error("unowned menu"); } }), count: async () => 0 }),
  };
  const slider = {
    ...hidden,
    locator: () => ({ isVisible: async () => openWith === "hidden-slider" }),
    getAttribute: async (name: string) => ({ "aria-valuemin": "0", "aria-valuemax": "4", "aria-valuenow": "1" })[name],
  };
  const control = {
    last() { return this; }, waitFor: async () => {},
    getAttribute: async (name: string) => {
      if (name === "aria-controls") return opened ? "owned-effort" : null;
      if (name === "aria-expanded") return String(expanded);
      if (name === "data-state") return expanded ? "open" : "closed";
      return null;
    },
    click: async (options: unknown) => {
      clickOptions.push(options);
      events.push("click"); expanded = true; opened = openWith === "click";
    },
    press: async () => { events.push("control-enter"); },
    dispatchEvent: async (event: string, detail: unknown) => {
      expect(event).toBe("pointerdown");
      expect(detail).toEqual({ button: 0, buttons: 1, pointerType: "mouse", isPrimary: true });
      events.push("pointerdown"); opened = openWith === "pointerdown"; expanded = true;
    },
  };
  const page = {
    locator: (selector: string) => {
      if (selector === '[id="owned-effort"]') return owned;
      if (selector === CHATGPT_EFFORT_MENU_SELECTOR) return stale;
      if (selector === CHATGPT_EFFORT_SLIDER_SELECTOR) return { filter: () => hidden, last: () => slider };
      return hiddenAlert;
    },
    keyboard: { press: async (key: string) => { events.push(key); expanded = false; } },
  };
  return { page, control, owned, slider, events, clickOptions };
}

test("effort activation returns the menu owned by the clicked control", async () => {
  const f = fixture("click");
  const result = await activateChatGptEffortMenu(f.page as never, f.control as never, { settleMs: 0 });
  expect(result.method).toBe("click");
  expect(result.menu).toBe(f.owned as never);
  expect(f.events).toEqual(["click"]);
  expect(f.clickOptions).toEqual([{ force: true, timeout: 1 }]);
});

test("a ghost click is reset before a single primary pointerdown fallback", async () => {
  const f = fixture("pointerdown");
  const result = await activateChatGptEffortMenu(f.page as never, f.control as never, { settleMs: 0 });
  expect(result.method).toBe("pointerdown");
  expect(result.menu).toBe(f.owned as never);
  expect(f.events).toEqual(["click", "Escape", "pointerdown"]);
});

test("activation fails closed when no owned menu or slider surface appears", async () => {
  const f = fixture("none");
  await expect(activateChatGptEffortMenu(f.page as never, f.control as never, { settleMs: 0 }))
    .rejects.toThrow("did not expose its owned menu or structural slider");
});

test("an invisible semantic slider remains usable through its visible menuitem container", async () => {
  const f = fixture("hidden-slider");
  const result = await activateChatGptEffortMenu(f.page as never, f.control as never, { settleMs: 0 });
  expect(result.method).toBe("already-open");
  expect(result.slider).toBe(f.slider as never);
  expect(f.events).toEqual([]);
});

test("production model selection uses activation-owned menu instead of a stale global menu", async () => {
  const f = fixture("click");
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    activeComposer: async () => ({ locator: () => ({ locator: () => f.control }) }),
  });
  await expect(worker.selectModelAndEffort(f.page, CHATGPT_WEB_MODEL_ID, "medium", {
    localToolsEnabled: true, solAvailable: true, proAvailable: true,
  })).resolves.toMatchObject({ uiEffortIndex: 1 });
  expect(f.events).toEqual(["click", "Escape"]);
});

test.each([false, true])("activation failure retains structured error classification (late 429: %s)", async limited => {
  const f = fixture("none");
  let visible = false;
  const locator = f.page.locator;
  const dialog = {
    filter() { return this; }, last() { return this; },
    isVisible: async () => visible,
    getByRole: () => ({ last: () => ({ isVisible: async () => visible, press: async () => { visible = false; } }) }),
  };
  f.page.locator = ((selector: string) => selector === '[role="dialog"]' ? dialog : locator(selector)) as typeof locator;
  f.control.click = async () => {
    visible = limited;
    throw new Error("activation failed after the control changed");
  };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    activeComposer: async () => ({ locator: () => ({ locator: () => f.control }) }),
  });
  await expect(worker.selectModelAndEffort(f.page, CHATGPT_WEB_MODEL_ID, "medium", {
    localToolsEnabled: true, solAvailable: true, proAvailable: true,
  })).rejects.toMatchObject(limited
    ? { status: 429, code: "rate_limit_exceeded", retryable: false }
    : { status: 502, code: "upstream_server_error", retryable: true });
});
