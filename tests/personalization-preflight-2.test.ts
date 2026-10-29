import { expect, test } from "bun:test";
import { ensureChatGptPersonalizedConnectorAccess } from "../src/adapters/chatgpt-web/personalization";
import { matchesName, visibleLocator, personalizationLabels } from "./personalization-preflight-fixture";

test("a missing owned personalization menu closes the opened control and returns a connector error", async () => {
  const controller = new AbortController();
  let escapePresses = 0;
  const absent = visibleLocator(() => 0);
  const control = {
    waitFor: async () => {},
    click: async () => {},
    getAttribute: async () => "missing-personalization-menu",
  };
  const controls = {
    filter: () => controls,
    first: () => control,
    count: async () => 1,
  };
  const menu = {
    waitFor: async () => {
      const error = new Error("menu did not become visible");
      error.name = "TimeoutError";
      throw error;
    },
  };
  const page = {
    getByRole: () => absent,
    locator: (selector: string) => {
      if (selector.includes("aria-haspopup")) return controls;
      if (selector === "body") return {
        press: async (key: string) => {
        expect(key).toBe("Escape");
        escapePresses += 1;
        },
      };
      return menu;
    },
  } as any;

  await expect((ensureChatGptPersonalizedConnectorAccess as any)(
    page,
    undefined,
    async () => false,
    controller.signal,
  )).rejects.toMatchObject({
    status: 424,
    code: "connector_not_found",
  });
  expect(escapePresses).toBe(1);
});

test("personalization menu cleanup completes before the preflight error is returned", async () => {
  const controller = new AbortController();
  let escapePresses = 0;
  let releaseEscape!: () => void;
  let markEscapeStarted!: () => void;
  const escapeGate = new Promise<void>(resolve => { releaseEscape = resolve; });
  const escapeStarted = new Promise<void>(resolve => { markEscapeStarted = resolve; });
  const absent = visibleLocator(() => 0);
  const control = {
    waitFor: async () => {},
    click: async () => {},
    getAttribute: async () => "delayed-cleanup-menu",
  };
  const controls = { filter: () => controls, first: () => control, count: async () => 1 };
  const menu = {
    waitFor: async () => {
      const error = new Error("menu did not become visible");
      error.name = "TimeoutError";
      throw error;
    },
  };
  const page = {
    getByRole: () => absent,
    locator: (selector: string) => {
      if (selector.includes("aria-haspopup")) return controls;
      if (selector === "body") return {
        press: async (_key: string, options?: { signal?: AbortSignal }) => {
          markEscapeStarted();
          await Promise.race([
            escapeGate,
            new Promise<never>((_resolve, reject) => options?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("cleanup aborted", "AbortError")),
              { once: true },
            )),
          ]);
          escapePresses += 1;
        },
      };
      return menu;
    },
  } as any;

  let settled = false;
  const preflight = (ensureChatGptPersonalizedConnectorAccess as any)(
    page,
    undefined,
    async () => false,
    controller.signal,
  ).finally(() => { settled = true; });
  const outcome = preflight.then(
    () => ({ error: undefined }),
    (error: unknown) => ({ error }),
  );
  await escapeStarted;
  expect(settled).toBeFalse();
  expect(escapePresses).toBe(0);
  releaseEscape();
  const { error } = await outcome;
  expect(error).toMatchObject({ status: 424, code: "connector_not_found" });
  expect(settled).toBeTrue();
  expect(escapePresses).toBe(1);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(escapePresses).toBe(1);
});

test("the labeled Unpersonalized path never hides an unclosed menu", async () => {
  let menuOpen = false;
  const personalized = visibleLocator(() => 0);
  const unpersonalized = visibleLocator(() => 1, {
    click: async () => { menuOpen = true; },
    getAttribute: async () => "labeled-cleanup-menu",
  });
  const page = {
    getByRole: (_role: string, options: { name: string | RegExp }) => (
      matchesName(options.name, "Personalized") ? personalized : unpersonalized
    ),
    locator: (selector: string) => {
      if (selector === "body") return {
        press: async () => { throw new Error("escape cleanup failed"); },
      };
      return {
        waitFor: async () => {
          const error = new Error("owned menu never became visible");
          error.name = "TimeoutError";
          throw error;
        },
      };
    },
  } as any;

  await expect(ensureChatGptPersonalizedConnectorAccess(page)).rejects.toMatchObject({
    name: "ChatGptPersistentBrowserStateError",
    message: "ChatGPT labeled personalization change failed and its menu could not be closed",
  });
  expect(menuOpen).toBeTrue();
});

test("an absolute deadline never hides a failed personalization rollback", async () => {
  const originalNow = Date.now;
  let now = 20_000;
  let personalized = false;
  let menuOpen = false;
  let proofCalls = 0;
  Date.now = () => now;
  const absent = visibleLocator(() => 0);
  const choices = {
    filter: () => choices,
    count: async () => 2,
    nth: (index: number) => ({
      getAttribute: async (name: string) => {
        if (name === "aria-checked") return String(index === (personalized ? 1 : 0));
        if (name === "data-state") return index === (personalized ? 1 : 0) ? "checked" : "unchecked";
        return null;
      },
      click: async () => {
        personalized = index === 1;
        menuOpen = false;
      },
    }),
  };
  const menu = {
    locator: () => choices,
    waitFor: async ({ state }: { state: string }) => {
      expect(menuOpen).toBe(state === "visible");
    },
  };
  const control = {
    waitFor: async () => {},
    click: async () => { menuOpen = true; },
    getAttribute: async () => "deadline-rollback-menu",
  };
  const controls = { filter: () => controls, first: () => control, count: async () => 1 };
  const page = {
    getByRole: () => absent,
    locator: (selector: string) => {
      if (selector.includes("aria-haspopup")) return controls;
      if (selector === "body") return {
        press: async () => { throw new Error("rollback blocked"); },
      };
      return menu;
    },
  } as any;
  try {
    let failure: unknown;
    try {
      await (ensureChatGptPersonalizedConnectorAccess as any)(
        page,
        undefined,
        async () => {
          proofCalls += 1;
          if (proofCalls === 1) return false;
          now += 30_001;
          return false;
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: "ChatGptPersistentBrowserStateError",
      message: "ChatGPT personalization could not prove connector access or restore its original state",
    });
    expect(failure).toBeInstanceOf(AggregateError);
    expect(personalized).toBeTrue();
  } finally {
    Date.now = originalNow;
  }
});

test("ambiguous personalization controls fail before connector selection", async () => {
  const visible = visibleLocator(() => 1);
  const page = { getByRole: () => visible } as any;

  await expect(ensureChatGptPersonalizedConnectorAccess(page)).rejects.toMatchObject({
    status: 424,
    code: "connector_not_found",
    retryable: false,
  });
});
