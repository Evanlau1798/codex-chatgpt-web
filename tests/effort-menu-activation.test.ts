import { expect, test } from "bun:test";
import {
  activateChatGptEffortMenu, CHATGPT_EFFORT_MENU_SELECTOR, CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR,
} from "../src/chatgpt-session";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

function fixture(
  openWith: "click" | "pointerdown" | "none" | "hidden-slider",
  ignoredEscapeCalls: ReadonlySet<number> = new Set(),
  closeDelayMs = 0,
) {
  let opened = false;
  let expanded = openWith === "hidden-slider";
  let escapeCalls = 0;
  let pointerActivated = false;
  const events: string[] = [];
  const clickOptions: unknown[] = [];
  const hidden = {
    filter() { return this; }, last() { return this; },
    isVisible: async () => false, count: async () => 0,
    locator() { return this; },
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
    waitFor: async () => { if (!opened && openWith !== "hidden-slider") throw new Error("slider missing"); },
    locator: () => ({ isVisible: async () => openWith === "hidden-slider" }),
    getAttribute: async (name: string) => ({ "aria-valuemin": "0", "aria-valuemax": "4", "aria-valuenow": "1" })[name],
  };
  const control = {
    last() { return this; }, first() { return this; }, filter() { return this; },
    count: async () => 1, innerText: async () => "Medium", waitFor: async () => {},
    getAttribute: async (name: string) => {
      if (name === "aria-controls") return opened ? "owned-effort" : null;
      if (name === "aria-expanded") return String(expanded);
      if (name === "data-state") return expanded ? "open" : "closed";
      return null;
    },
    click: async (options: unknown) => {
      clickOptions.push(options);
      events.push("click"); expanded = true;
      opened = openWith === "click" || (openWith === "pointerdown" && pointerActivated);
    },
    press: async () => { events.push("control-enter"); },
    dispatchEvent: async (event: string, detail: unknown) => {
      expect(event).toBe("pointerdown");
      expect(detail).toEqual({ button: 0, buttons: 1, pointerType: "mouse", isPrimary: true });
      events.push("pointerdown"); opened = openWith === "pointerdown"; expanded = true;
      pointerActivated ||= opened;
    },
  };
  const page = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    locator: (selector: string) => {
      if (selector === '[id="owned-effort"]') return owned;
      if (selector === CHATGPT_EFFORT_MENU_SELECTOR) return stale;
      if (selector === CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR) return {
        ...hidden,
        isVisible: async () => opened || openWith === "hidden-slider",
        waitFor: async () => { if (!opened && openWith !== "hidden-slider") throw new Error("container missing"); },
        locator: () => slider,
        evaluate: async () => ({
          min: "0",
          max: "4",
          value: "1",
          locks: ["false", "false", "false", "false", "false"],
        }),
      };
      return hiddenAlert;
    },
    keyboard: { press: async (key: string) => {
      events.push(key);
      if (key === "Escape" && !ignoredEscapeCalls.has(++escapeCalls)) {
        if (closeDelayMs) setTimeout(() => { expanded = false; }, closeDelayMs);
        else expanded = false;
      }
    } },
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

test("a committed owned menu survives a delayed click acknowledgement", async () => {
  const f = fixture("click");
  const click = f.control.click;
  f.control.click = async options => {
    await click(options);
    throw Object.assign(new Error("click acknowledgement timed out"), { name: "TimeoutError" });
  };
  const result = await activateChatGptEffortMenu(f.page as never, f.control as never);
  expect(result.method).toBe("click");
  expect(result.menu).toBe(f.owned as never);
  expect(f.events).toEqual(["click"]);
});

test.each(["TimeoutError", "AbortError"])("an unproven click or cancellation preserves its original %s", async name => {
  const f = fixture(name === "TimeoutError" ? "none" : "click");
  const click = f.control.click;
  const error = Object.assign(new Error("click failed"), { name });
  f.control.click = async options => { await click(options); throw error; };
  await expect(activateChatGptEffortMenu(f.page as never, f.control as never)).rejects.toBe(error);
  expect(f.events).toEqual(["click"]);
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

test("production model selection uses the opened slider instead of stale global model rows", async () => {
  const f = fixture("click");
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    activeComposer: async () => ({ isEditable: async () => true, locator: () => ({ locator: () => f.control }) }),
  });
  await expect(worker.selectModelAndEffort(f.page, CHATGPT_WEB_MODEL_ID, "medium", {
    localToolsEnabled: true, solAvailable: true, proAvailable: true,
  })).resolves.toMatchObject({ uiEffortIndex: 1 });
  expect(f.events).toEqual(["click", "Escape", "click", "Escape"]);
});

test("production model selection retries one ignored effort-menu close", async () => {
  // The first Escape clears the ghost click before pointerdown activation. The
  // second is the first post-selection close and is ignored by the live UI.
  const f = fixture("pointerdown", new Set([2]));
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    activeComposer: async () => ({ isEditable: async () => true, locator: () => ({ locator: () => f.control }) }),
  });
  await expect(worker.selectModelAndEffort(f.page, CHATGPT_WEB_MODEL_ID, "medium", {
    localToolsEnabled: true, solAvailable: true, proAvailable: true,
  })).resolves.toMatchObject({ uiEffortIndex: 1 });
  expect(f.events).toEqual(["click", "Escape", "pointerdown", "Escape", "Escape", "click", "Escape"]);
}, 10_000);

test.each([false, true])("activation failure retains structured error classification (late 429: %s)", async limited => {
  const f = fixture("none");
  let visible = false;
  const locator = f.page.locator;
  const dialogText = "Too many requests. You're making requests too quickly.";
  const hiddenDialog = {
    waitFor: () => new Promise<void>(() => {}),
    filter() { return this; }, last() { return this; },
    isVisible: async () => false,
    getByRole: () => ({ last: () => ({ isVisible: async () => false, press: async () => {} }) }),
  };
  const dialog = {
    waitFor: () => new Promise<void>(() => {}),
    filter({ hasText }: { hasText?: RegExp }) { return hasText?.test(dialogText) === false ? hiddenDialog : this; },
    last() { return this; },
    isVisible: async () => visible,
    getByRole: () => ({ last: () => ({ isVisible: async () => visible, press: async () => { visible = false; } }) }),
  };
  f.page.locator = ((selector: string) => selector === '[role="dialog"]' ? dialog : locator(selector)) as typeof locator;
  f.control.click = async () => {
    visible = limited;
    throw new Error("activation failed after the control changed");
  };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    activeComposer: async () => ({ isEditable: async () => true, locator: () => ({ locator: () => f.control }) }),
  });
  await expect(worker.selectModelAndEffort(f.page, CHATGPT_WEB_MODEL_ID, "medium", {
    localToolsEnabled: true, solAvailable: true, proAvailable: true,
  })).rejects.toMatchObject(limited
    ? { status: 429, code: "rate_limit_exceeded", retryable: false }
    : { status: 502, code: "upstream_server_error", retryable: true });
});

// The original French delayed-close regression also exercises the current official close path.
test("model selection waits for both delayed menu closes before accepting the effort", async () => {
  const f = fixture("click", new Set(), 600);
  f.control.innerText = async () => await f.control.getAttribute("aria-expanded") === "true" ? "Effort de réflexion" : "Moyen";
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    activeComposer: async () => ({ isEditable: async () => true, locator: () => ({ locator: () => f.control }) }),
  });
  const mode = await worker.selectModelAndEffort(f.page, CHATGPT_WEB_MODEL_ID, "medium", {
    localToolsEnabled: true, solAvailable: true, proAvailable: true,
  });
  expect(mode.selection.label).toBe("Moyen");
  expect(await f.control.getAttribute("aria-expanded")).toBe("false");
  expect(f.events).toEqual(["click", "Escape", "click", "Escape"]);
});
