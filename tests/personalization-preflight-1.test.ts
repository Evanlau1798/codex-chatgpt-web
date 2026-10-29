import { expect, test } from "bun:test";
import { ensureChatGptPersonalizedConnectorAccess } from "../src/adapters/chatgpt-web/personalization";
import { matchesName, visibleLocator, personalizationLabels } from "./personalization-preflight-fixture";

test("a missing personalization control fails closed before connector selection", async () => {
  const diagnostics: string[] = [];
  const absent = visibleLocator(() => 0);
  let clicks = 0;
  const controls: any = { filter: () => controls, first: () => controls, count: async () => 0,
    click: async () => { clicks++; },
    waitFor: async () => { throw Object.assign(new Error("no structural control"), { name: "TimeoutError" }); } };
  const page = { getByRole: () => absent, locator: (selector: string) => selector === "body"
    ? { press: async () => {} } : controls } as any;

  await expect(ensureChatGptPersonalizedConnectorAccess(
    page,
    async checkpoint => { diagnostics.push(checkpoint); },
  )).rejects.toMatchObject({
    status: 424,
    code: "connector_not_found",
    retryable: false,
  });
  expect(diagnostics).toEqual(["personalization-unpersonalized"]);
  expect(clicks).toBe(0);
});

for (const labels of personalizationLabels) test(`an ${labels.unpersonalized} Temporary Chat is switched through its owned radio menu and re-proved`, async () => {
  let enabled = false;
  let menuOpen = false;
  const events: string[] = [];
  const diagnostics: string[] = [];
  const personalized = visibleLocator(() => enabled ? 1 : 0, {
    waitFor: async ({ state }: { state: string }) => {
      expect(state).toBe("visible");
      expect(enabled).toBeTrue();
      events.push("personalized-visible");
    },
  });
  const unpersonalized = visibleLocator(() => enabled ? 0 : 1, {
    click: async () => { menuOpen = true; events.push("control-clicked"); },
    getAttribute: async (name: string) => {
      expect(name).toBe("aria-controls");
      expect(menuOpen).toBeTrue();
      return "personalization-menu";
    },
    waitFor: async ({ state }: { state: string }) => {
      expect(state).toBe("hidden");
      expect(enabled).toBeTrue();
      events.push("unpersonalized-hidden");
    },
  });
  const choice = {
    count: async () => 1,
    click: async () => { enabled = true; events.push("choice-clicked"); },
  };
  const menu = {
    waitFor: async ({ state }: { state: string }) => {
      if (state === "visible") expect(menuOpen).toBeTrue();
      else {
        expect(state).toBe("hidden");
        expect(menuOpen).toBeFalse();
      }
      events.push("menu-visible");
    },
    locator: (selector: string) => {
      expect(selector).toBe('[role="menuitemradio"], [role="radio"]');
      return {
        filter: ({ hasText }: { hasText: RegExp }) => {
          expect(hasText.test(`${labels.personalized}This chat can reference plugins`)).toBeTrue();
          expect(hasText.test(`${labels.unpersonalized}This chat ignores plugins`)).toBeFalse();
          return choice;
        },
      };
    },
  };
  const page = {
    getByRole: (_role: string, options: { name: string | RegExp }) => {
      if (matchesName(options.name, labels.personalized)) {
        expect(matchesName(options.name, labels.unpersonalized)).toBeFalse();
        expect(matchesName(options.name, `${labels.personalized} settings`)).toBeFalse();
        return personalized;
      }
      if (matchesName(options.name, labels.unpersonalized)) return unpersonalized;
      return visibleLocator(() => 0);
    },
    locator: (selector: string) => {
      expect(selector).toBe('[id="personalization-menu"]');
      return menu;
    },
  } as any;

  expect(await ensureChatGptPersonalizedConnectorAccess(
    page,
    async checkpoint => { diagnostics.push(checkpoint); },
  )).toBe("enabled");
  expect(diagnostics).toEqual(["personalization-unpersonalized", "personalization-enabled"]);
  expect(events).toEqual([
    "control-clicked",
    "menu-visible",
    "choice-clicked",
    "personalized-visible",
    "unpersonalized-hidden",
  ]);
});

test("a localized already-Personalized Temporary Chat is proved by connector catalog access without clicking UI", async () => {
  const diagnostics: string[] = [];
  const absent = visibleLocator(() => 0);
  const page = { getByRole: () => absent } as any;

  expect(await ensureChatGptPersonalizedConnectorAccess(
    page,
    async checkpoint => { diagnostics.push(checkpoint); },
    async () => true,
  )).toBe("already-personalized");
  expect(diagnostics).toEqual(["personalization-already-enabled"]);
});

test("a localized Unpersonalized Temporary Chat toggles the structural state and proves connector access", async () => {
  let connectorCatalogAvailable = false;
  let menuOpen = false;
  let personalized = false;
  const diagnostics: string[] = [];
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
        expect(index).toBe(1);
        personalized = true;
        connectorCatalogAvailable = true;
        menuOpen = false;
      },
    }),
  };
  const menu = {
    waitFor: async ({ state }: { state: string }) => {
      if (state === "visible") expect(menuOpen).toBeTrue();
      else {
        expect(state).toBe("hidden");
        expect(menuOpen).toBeFalse();
      }
    },
    locator: (selector: string) => {
      expect(selector).toBe('[role="menuitemradio"], [role="radio"]');
      return choices;
    },
  };
  const control = {
    waitFor: async ({ state }: { state: string }) => {
      expect(state).toBe("visible");
    },
    getAttribute: async (name: string) => {
      expect(name).toBe("aria-controls");
      return "localized-personalization-menu";
    },
    click: async () => { menuOpen = true; },
  };
  const controls = {
    filter: () => controls,
    count: async () => 1,
    first: () => control,
  };
  const page = {
    getByRole: () => absent,
    locator: (selector: string) => {
      if (selector.includes('[aria-haspopup="menu"]')) return controls;
      expect(selector).toBe('[id="localized-personalization-menu"]');
      return menu;
    },
    keyboard: { press: async () => {} },
  } as any;

  expect(await ensureChatGptPersonalizedConnectorAccess(
    page,
    async checkpoint => { diagnostics.push(checkpoint); },
    async () => connectorCatalogAvailable,
  )).toBe("enabled");
  expect(diagnostics).toEqual(["personalization-unpersonalized", "personalization-enabled"]);
  expect(personalized).toBeTrue();
});

test("a localized preflight waits for its semantic control to hydrate without assuming a button tag", async () => {
  const controller = new AbortController();
  let controlReady = false;
  let connectorCatalogAvailable = false;
  let menuOpen = false;
  let ownershipReads = 0;
  let personalized = false;
  const absent = visibleLocator(() => 0);
  const choices = {
    filter: () => choices,
    count: async () => 2,
    nth: (index: number) => ({
      getAttribute: async (name: string, options?: { signal?: AbortSignal; timeout?: number }) => {
        expect(options?.signal).toBeDefined();
        expect(options?.timeout).toBeGreaterThan(0);
        if (name === "aria-checked") return String(index === (personalized ? 1 : 0));
        if (name === "data-state") return index === (personalized ? 1 : 0) ? "checked" : "unchecked";
        return null;
      },
      click: async (options?: { signal?: AbortSignal; timeout?: number }) => {
        expect(options?.signal).toBeDefined();
        expect(options?.timeout).toBeGreaterThan(0);
        expect(index).toBe(1);
        personalized = true;
        connectorCatalogAvailable = true;
        menuOpen = false;
      },
    }),
  };
  const control = {
    waitFor: async ({ state, signal, timeout }: { state: string; signal?: AbortSignal; timeout?: number }) => {
      expect(state).toBe("visible");
      expect(signal).toBeDefined();
      expect(timeout).toBeGreaterThan(0);
      controlReady = true;
    },
    click: async (options?: { signal?: AbortSignal; timeout?: number }) => {
      expect(options?.signal).toBeDefined();
      expect(options?.timeout).toBeGreaterThan(0);
      menuOpen = true;
    },
    getAttribute: async (name: string, options?: { signal?: AbortSignal; timeout?: number }) => {
      expect(name).toBe("aria-controls");
      expect(options?.signal).toBeDefined();
      expect(options?.timeout).toBeGreaterThan(0);
      ownershipReads += 1;
      return ownershipReads > 1 ? "hydrated-personalization-menu" : null;
    },
  };
  const controls = {
    filter: () => controls,
    count: async () => {
      expect(controlReady).toBeTrue();
      return 1;
    },
    first: () => control,
  };
  const menu = {
    waitFor: async ({ state, signal, timeout }: { state: string; signal?: AbortSignal; timeout?: number }) => {
      expect(signal).toBeDefined();
      expect(timeout).toBeGreaterThan(0);
      if (state === "visible") expect(menuOpen).toBeTrue();
      else {
        expect(state).toBe("hidden");
        expect(menuOpen).toBeFalse();
      }
    },
    locator: (selector: string) => {
      expect(selector).toBe('[role="menuitemradio"], [role="radio"]');
      return choices;
    },
  };
  const page = {
    getByRole: () => absent,
    locator: (selector: string) => {
      if (selector.includes('[aria-haspopup="menu"]')) {
        expect(selector).toBe(
          '[data-testid="thread-header-right-actions"] [aria-haspopup="menu"], '
          + '#conversation-header-actions [aria-haspopup="menu"], '
          + '[data-content-sheet-root] > button[aria-expanded][aria-controls]',
        );
        return controls;
      }
      expect(selector).toBe('[id="hydrated-personalization-menu"]');
      return menu;
    },
    keyboard: { press: async () => {} },
  } as any;

  expect(await (ensureChatGptPersonalizedConnectorAccess as any)(
    page,
    undefined,
    async () => connectorCatalogAvailable,
    controller.signal,
  )).toBe("enabled");
  expect(ownershipReads).toBe(2);
});

test("an aborted localized preflight cannot click after its structural readiness wait", async () => {
  const controller = new AbortController();
  let controlClicks = 0;
  let markControlWaitStarted!: () => void;
  const controlWaitStarted = new Promise<void>(resolve => { markControlWaitStarted = resolve; });
  const absent = visibleLocator(() => 0);
  const control = {
    waitFor: async ({ signal }: { signal?: AbortSignal }) => {
      markControlWaitStarted();
      expect(signal).toBeDefined();
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    },
    click: async () => { controlClicks += 1; },
  };
  const controls = {
    filter: () => controls,
    first: () => control,
    count: async () => 1,
  };
  const page = {
    getByRole: () => absent,
    locator: (selector: string) => selector === "body"
      ? { press: async (key: string) => { expect(key).toBe("Escape"); } }
      : controls,
  } as any;

  const preflight = (ensureChatGptPersonalizedConnectorAccess as any)(
    page,
    undefined,
    async () => false,
    controller.signal,
  );
  await controlWaitStarted;
  controller.abort();
  await expect(preflight).rejects.toMatchObject({ name: "AbortError" });
  expect(controlClicks).toBe(0);
});

test("an abort during localized connector proof restores the exact preflight personalization state", async () => {
  const controller = new AbortController();
  let personalized = false;
  let menuOpen = false;
  let proofCalls = 0;
  const choiceClicks: number[] = [];
  const absent = visibleLocator(() => 0);
  const choices = {
    filter: () => choices,
    count: async () => 2,
    nth: (index: number) => ({
      getAttribute: async (name: string, options?: { signal?: AbortSignal; timeout?: number }) => {
        expect(options?.signal?.aborted).toBeFalse();
        expect(options?.timeout).toBeGreaterThan(0);
        if (name === "aria-checked") return String(index === (personalized ? 1 : 0));
        if (name === "data-state") return index === (personalized ? 1 : 0) ? "checked" : "unchecked";
        return null;
      },
      click: async (options?: { signal?: AbortSignal; timeout?: number }) => {
        expect(options?.signal?.aborted).toBeFalse();
        expect(options?.timeout).toBeGreaterThan(0);
        choiceClicks.push(index);
        personalized = index === 1;
        menuOpen = false;
      },
    }),
  };
  const menu = {
    locator: () => choices,
    waitFor: async ({ state, signal }: { state: string; signal?: AbortSignal }) => {
      expect(signal?.aborted).toBeFalse();
      expect(menuOpen).toBe(state === "visible");
    },
  };
  const control = {
    waitFor: async ({ signal }: { signal?: AbortSignal }) => {
      expect(signal?.aborted).toBeFalse();
    },
    click: async ({ signal }: { signal?: AbortSignal }) => {
      expect(signal?.aborted).toBeFalse();
      menuOpen = true;
    },
    getAttribute: async (_name: string, { signal }: { signal?: AbortSignal }) => {
      expect(signal?.aborted).toBeFalse();
      return "transactional-personalization-menu";
    },
  };
  const controls = {
    filter: () => controls,
    first: () => control,
    count: async () => 1,
  };
  const page = {
    getByRole: () => absent,
    locator: (selector: string) => {
      if (selector.includes("aria-haspopup")) return controls;
      if (selector === "body") return {
        press: async (key: string, options?: { signal?: AbortSignal }) => {
          expect(key).toBe("Escape");
          expect(options?.signal?.aborted).toBeFalse();
          menuOpen = false;
        },
      };
      expect(selector).toBe('[id="transactional-personalization-menu"]');
      return menu;
    },
  } as any;

  const preflight = (ensureChatGptPersonalizedConnectorAccess as any)(
    page,
    undefined,
    async () => {
      proofCalls += 1;
      if (proofCalls === 1) return false;
      controller.abort();
      throw new DOMException("proof aborted", "AbortError");
    },
    controller.signal,
  );
  await expect(preflight).rejects.toMatchObject({ name: "AbortError" });
  expect(proofCalls).toBe(2);
  expect(choiceClicks).toEqual([1, 0]);
  expect(personalized).toBeFalse();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(personalized).toBeFalse();
});
