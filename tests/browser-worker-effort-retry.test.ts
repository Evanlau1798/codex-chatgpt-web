import { describe, expect, test } from "bun:test";
import {
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_ITEM_SELECTOR,
  CHATGPT_EFFORT_MENU_SELECTOR,
  CHATGPT_EFFORT_SLIDER_SELECTOR,
} from "../src/chatgpt-session";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

const timeout = () => Object.assign(new Error("timed out"), { name: "TimeoutError" });

function effortMenuFixture(itemCount: number) {
  const unavailable = { waitFor: async () => { throw timeout(); } };
  const effortChoices = {
    nth: () => unavailable,
    count: async () => itemCount,
  };
  const effortMenu = {
    last() { return this; },
    isVisible: async () => false,
    locator: (selector: string) => {
      expect(selector).toBe(CHATGPT_EFFORT_ITEM_SELECTOR);
      return effortChoices;
    },
  };
  const effortSlider = {
    waitFor: async ({ state }: { state: string }) => {
      expect(state).toBe("attached");
      throw timeout();
    },
  };
  const effortSliderCollection = {
    filter() { throw new Error("semantic effort sliders may be visually hidden"); },
    last: () => effortSlider,
  };
  const rateLimitDialog = {
    filter() { return this; },
    last() { return this; },
    isVisible: async () => false,
    waitFor: async () => { throw timeout(); },
  };
  const effortControl = {
    last() { return this; },
    waitFor: async () => {},
    getAttribute: async (name: string) => name === "aria-expanded" ? "false" : null,
    press: async () => {},
  };
  const composerForm = {
    locator: (selector: string) => {
      expect(selector).toBe(CHATGPT_EFFORT_CONTROL_SELECTOR);
      return effortControl;
    },
  };
  const composer = { locator: () => composerForm };
  const page = {
    locator: (selector: string) => {
      if (selector === CHATGPT_EFFORT_MENU_SELECTOR) return effortMenu;
      if (selector === CHATGPT_EFFORT_SLIDER_SELECTOR) return effortSliderCollection;
      if (selector === '[role="dialog"]') return rateLimitDialog;
      throw new Error(`Unexpected selector: ${selector}`);
    },
  };
  return { composer, page };
}

async function effortMenuError(itemCount: number): Promise<ChatGptWebAdapterError> {
  const fixture = effortMenuFixture(itemCount);
  const selectModelAndEffort = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffort(
      page: unknown,
      modelId: string,
      reasoning: string,
      capabilities: { localToolsEnabled: boolean; solAvailable: boolean; proAvailable: boolean },
    ): Promise<unknown>;
  }).selectModelAndEffort;
  try {
    await selectModelAndEffort.call({
      activeComposer: async () => fixture.composer,
    }, fixture.page, CHATGPT_WEB_MODEL_ID, "medium", {
      localToolsEnabled: true,
      solAvailable: true,
      proAvailable: false,
    });
  } catch (error) {
    expect(error).toBeInstanceOf(ChatGptWebAdapterError);
    return error as ChatGptWebAdapterError;
  }
  throw new Error("Expected effort selection to fail");
}

describe("ChatGPT effort menu failure classification", () => {
  test("selects an attached semantic slider even when its thumb has no visible box", async () => {
    let sliderValue = 3;
    const pressed: string[] = [];
    const sliderControl = {
      press: async (key: string) => {
        pressed.push(key);
        sliderValue += key === "ArrowLeft" ? -1 : 1;
      },
    };
    const slider = {
      waitFor: async ({ state }: { state: string }) => expect(state).toBe("attached"),
      getAttribute: async (name: string) => ({
        "aria-valuemin": "0",
        "aria-valuemax": "4",
        "aria-valuenow": String(sliderValue),
      })[name as "aria-valuemin" | "aria-valuemax" | "aria-valuenow"],
      locator: () => sliderControl,
    };
    const hiddenSliderCollection = {
      filter() { throw new Error("semantic effort sliders may be visually hidden"); },
      last: () => slider,
    };
    const unavailableChoice = { waitFor: () => new Promise(() => {}) };
    const effortMenu = {
      last() { return this; },
      isVisible: async () => false,
      locator: () => ({ nth: () => unavailableChoice }),
    };
    const effortControl = {
      last() { return this; },
      waitFor: async () => {},
      getAttribute: async () => "false",
      press: async () => {},
    };
    const composer = { locator: () => ({ locator: () => effortControl }) };
    const hiddenDialog = {
      filter() { return this; },
      last() { return this; },
      isVisible: async () => false,
      waitFor: () => new Promise(() => {}),
    };
    const page = {
      locator: (selector: string) => {
        if (selector === CHATGPT_EFFORT_MENU_SELECTOR) return effortMenu;
        if (selector === CHATGPT_EFFORT_SLIDER_SELECTOR) return hiddenSliderCollection;
        if (selector === '[role="dialog"]') return hiddenDialog;
        throw new Error(`Unexpected selector: ${selector}`);
      },
      keyboard: { press: async () => {} },
    };
    const selectModelAndEffort = (ChatGptBrowserWorker.prototype as unknown as {
      selectModelAndEffort(
        page: unknown,
        modelId: string,
        reasoning: string,
        capabilities: { localToolsEnabled: boolean; solAvailable: boolean; proAvailable: boolean },
      ): Promise<unknown>;
    }).selectModelAndEffort;

    await expect(selectModelAndEffort.call({ activeComposer: async () => composer },
      page, CHATGPT_WEB_MODEL_ID, "medium", {
        localToolsEnabled: true,
        solAvailable: true,
        proAvailable: false,
      })).resolves.toBeDefined();
    expect(pressed).toEqual(["ArrowLeft", "ArrowLeft"]);
  });

  test("retries a temporarily empty effort menu on a fresh browser surface", async () => {
    const error = await effortMenuError(0);
    expect(error).toMatchObject({ status: 502, code: "upstream_server_error", retryable: true });
  });

  test("fails closed when a non-empty menu lacks the requested effort index", async () => {
    const error = await effortMenuError(1);
    expect(error).toMatchObject({ status: 502, code: "upstream_server_error", retryable: false });
  });
});
