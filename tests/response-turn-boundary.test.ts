import { expect, test } from "bun:test";
import { CHATGPT_USER_TURN_SELECTOR } from "../src/chatgpt-session";
import {
  activateChatGptSendControl,
  activateOwnedChatGptSendControl,
  ChatGptOwnedSendStateUnknownError,
  bindChatGptAssistantTurn,
  chatGptAssistantTurnChanged,
  chatGptNewTurnIdentity,
  chatGptSubmissionEvidence,
  countChatGptTurnRoots,
  locateChatGptAssistantTurn,
  ChatGptTurnIdentityAmbiguityError,
  readChatGptAssistantTurnState,
  readChatGptTurnIdentities,
  reconcileChatGptAssistantTurnBinding,
  clearOwnedChatGptComposerControl,
} from "../src/adapters/chatgpt-web/response-turn-boundary";

test("logical turn counts collapse nested legacy and grouped roots", async () => {
  const { createWindow } = require("@mixmark-io/domino") as {
    createWindow(html: string): { document: Document };
  };
  const document = createWindow(`
    <article data-testid="conversation-turn-1"><div data-message-author-role="user">
      <section data-turn-key="one"><div data-user-message-bubble></div></section>
    </div></article>
    <article data-testid="conversation-turn-2"><div data-message-author-role="user">
      <section data-turn-key="two"><div data-user-message-bubble></div></section>
    </div></article>
  `).document;
  const nodes = [...document.querySelectorAll(
    '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"]), [data-turn-key]:has([data-user-message-bubble])',
  )];
  const turns = {
    evaluateAll: async (callback: (elements: Element[]) => unknown) => callback(nodes),
  };
  expect(nodes).toHaveLength(4);
  expect(await countChatGptTurnRoots(turns as never)).toBe(2);
});

test("grouped completed turns remain user-submission evidence when the user bubble is hidden", async () => {
  const { createWindow } = require("@mixmark-io/domino") as {
    createWindow(html: string): { document: Document };
  };
  const document = createWindow(
    '<div data-turn-key="one"><h4 data-conversation-role="assistant"></h4></div>',
  ).document;
  const nodes = [...document.querySelectorAll(CHATGPT_USER_TURN_SELECTOR)];
  expect(nodes).toHaveLength(1);
});

test("duplicate DOM turn identities are classified as transient observation ambiguity", async () => {
  const turns = {
    evaluateAll(callback: (elements: Array<{ getAttribute(name: string): string | null }>, name: string) => unknown,
      name: string) {
      const elements = ["duplicate", "duplicate"].map(identity => ({
        getAttribute: () => identity,
      }));
      return Promise.resolve(callback(elements, name));
    },
  };

  await expect(readChatGptTurnIdentities(turns as never))
    .rejects.toBeInstanceOf(ChatGptTurnIdentityAmbiguityError);
});

test("power UI groups keep separate stable user and assistant identities", async () => {
  const { createWindow } = require("@mixmark-io/domino");
  const document = createWindow('<div data-turn-key="old"><div data-user-message-bubble></div></div><div data-turn-key="new"><div data-user-message-bubble></div><h4 data-conversation-role="assistant"></h4></div>').document;
  const groups = [...document.querySelectorAll("[data-turn-key]")];
  const locator = (elements: Element[]) => ({
    evaluateAll: async (callback: (elements: Element[], name?: string) => unknown, name?: string) => callback(elements, name),
  });
  const page = { locator: () => locator(groups) };
  const assistantTurns = { ...locator([groups[1]!]), page: () => page };
  const state = await readChatGptAssistantTurnState(assistantTurns as never);
  expect(state.identities).toEqual(["group:assistant:new"]);
  expect(state.knownTurnIdentities).toEqual([
    "group:user:old", "group:assistant:old", "group:user:new", "group:assistant:new",
  ]);
  expect(await readChatGptTurnIdentities(locator(groups) as never)).toEqual([
    "group:user:old", "group:user:new",
  ]);
  expect(chatGptSubmissionEvidence({
    initialUserTurnCount: 1,
    userTurnCount: 2,
    initialAssistantTurnCount: 0,
    assistantTurnCount: 1,
    initialTurnIdentities: ["group:user:old", "group:assistant:old"],
    userIdentities: ["group:user:old", "group:user:new"],
    responseIdentities: state.identities,
    generationRunning: false,
  })).toBe("user_turn");
});

test("assistant identity container remount between DOM reads is transient ambiguity", async () => {
  const { createWindow } = require("@mixmark-io/domino") as {
    createWindow(html: string): { document: Document };
  };
  const document = createWindow('<div data-turn-key="first"><h4 data-conversation-role="assistant"></h4></div>').document;
  let read = 0;
  const turns = {
    evaluateAll: async (callback: (elements: Element[]) => unknown) => {
      const snapshot = [...document.querySelectorAll("[data-turn-key]")];
      const result = callback(snapshot);
      if (read++ === 0) document.body.innerHTML = '<div data-turn-key="second"><h4 data-conversation-role="assistant"></h4></div>';
      return result;
    },
    page: () => ({
      locator: (selector: string) => ({
        evaluateAll: async (callback: (elements: Element[], name: string) => unknown, name: string) =>
          callback([...document.querySelectorAll(selector)], name),
      }),
    }),
  };
  await expect(readChatGptAssistantTurnState(turns as never))
    .rejects.toBeInstanceOf(ChatGptTurnIdentityAmbiguityError);
  expect((await readChatGptAssistantTurnState(turns as never)).lastId).toBe("group:assistant:second");
});

test("logical turn identities ignore remounted history and reject ambiguous additions", () => {
  expect(chatGptNewTurnIdentity(["turn-old-1", "turn-old-2"], ["turn-old-2"])).toBeUndefined();
  expect(chatGptNewTurnIdentity(["turn-old-1", "turn-old-2"], ["turn-old-2", "turn-new"]))
    .toBe("turn-new");
  expect(() => chatGptNewTurnIdentity(["turn-old"], ["turn-new-1", "turn-new-2"]))
    .toThrow("2 new conversation turns");
});

test("submission evidence uses the persistent logical baseline instead of display counts", () => {
  expect(chatGptSubmissionEvidence({
    initialUserTurnCount: 1,
    userTurnCount: 2,
    initialAssistantTurnCount: 1,
    assistantTurnCount: 1,
    initialTurnIdentities: ["turn-user-old", "turn-assistant-old"],
    userIdentities: ["turn-user-old"],
    responseIdentities: ["turn-assistant-old"],
    generationRunning: false,
  })).toBeUndefined();
  expect(chatGptSubmissionEvidence({
    initialUserTurnCount: 1,
    userTurnCount: 1,
    initialAssistantTurnCount: 1,
    assistantTurnCount: 1,
    initialTurnIdentities: ["turn-user-old", "turn-assistant-old"],
    userIdentities: ["turn-user-old"],
    responseIdentities: ["turn-assistant-new"],
    generationRunning: false,
  })).toBe("assistant_turn");
});

test("fresh Temporary Chat navigation with a cleared composer proves submission acceptance", () => {
  const state = {
    initialUserTurnCount: 0,
    userTurnCount: 0,
    initialAssistantTurnCount: 0,
    assistantTurnCount: 0,
    initialTurnIdentities: [],
    userIdentities: [],
    responseIdentities: [],
    generationRunning: false,
    initialPageUrl: "https://chatgpt.com/?temporary-chat=true",
    currentPageUrl: "https://chatgpt.com/c/compact-turn?temporary-chat=true",
    composerTextLength: 0,
    submissionRequestObserved: true,
  };
  expect(chatGptSubmissionEvidence(state)).toBe("conversation_navigation");
  expect(chatGptSubmissionEvidence({ ...state, submissionRequestObserved: false })).toBeUndefined();
  expect(chatGptSubmissionEvidence({ ...state, composerTextLength: 1 })).toBeUndefined();
  expect(chatGptSubmissionEvidence({
    ...state,
    initialPageUrl: "https://chatgpt.com/c/existing?temporary-chat=true",
  })).toBeUndefined();
  expect(chatGptSubmissionEvidence({
    ...state,
    initialPageUrl: "https://chatgpt.com/?temporary-chat=true&extra=1",
  })).toBeUndefined();
  expect(chatGptSubmissionEvidence({
    ...state,
    initialPageUrl: "https://chatgpt.com/?temporary-chat=true#state",
  })).toBeUndefined();
});

test("send control uses semantic keyboard activation", async () => {
  const activations: string[] = [];
  await activateChatGptSendControl({
    press: async key => { activations.push(`press:${key}`); },
  }, undefined, () => { activations.push("observe"); });
  expect(activations).toEqual(["observe", "press:Enter"]);
});

test("Send delegates its timeout and cancellation to the outer stage", async () => {
  const owner = new AbortController();
  const result = activateChatGptSendControl({
    press: async (key, options) => {
      expect(key).toBe("Enter");
      expect(options).toMatchObject({ noWaitAfter: true, timeout: 0, signal: owner.signal });
      return new Promise<void>((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
        owner.abort(new DOMException("outer stage cancelled", "AbortError"));
      });
    },
  }, owner.signal);
  await expect(result).rejects.toBe(owner.signal.reason);
});

test("owned recovery cleanup preserves a draft that replaced the recovery prompt", async () => {
  const { createWindow } = require("@mixmark-io/domino") as {
    createWindow(html: string): { document: Document };
  };
  const document = createWindow('<div id="composer" contenteditable="true">Recovery prompt</div>').document;
  const composer = document.querySelector("#composer")!;
  const locator = {
    evaluate: async (callback: (element: Element, input: string) => boolean, input: string) => {
      composer.textContent = "User draft";
      return callback(composer, input);
    },
  };

  expect(await clearOwnedChatGptComposerControl(locator as never, "Recovery prompt")).toBeFalse();
  expect(composer.textContent).toBe("User draft");
});

test("owned recovery Send rejects a late DOM final in the same renderer transaction", async () => {
  const { createWindow } = require("@mixmark-io/domino") as {
    createWindow(html: string): { document: Document; Event: typeof Event; HTMLButtonElement: typeof HTMLButtonElement };
  };
  const window = createWindow(`
    <article id="response"><div>tool result</div></article>
    <form><div id="composer" contenteditable="true">Recovery prompt</div><button id="send">Send</button></form>
  `);
  const composer = window.document.querySelector("#composer")!;
  const response = window.document.querySelector("#response")!;
  const button = window.document.querySelector("#send") as HTMLButtonElement;
  let clicks = 0;
  button.addEventListener("click", event => { event.preventDefault(); clicks += 1; });
  const locator = {
    evaluate: async (callback: (element: Element, input: unknown) => boolean, input: unknown) => {
      response.innerHTML += "<p>Late final</p>";
      return callback(composer, input);
    },
  };

  expect(await activateOwnedChatGptSendControl(locator as never, "Recovery prompt", "#send", {
    responseSelector: "#response",
    responseHtml: "<div>tool result</div>",
    stopButtonSelector: "#stop",
    deadlineAt: Date.now() + 10_000,
  })).toBeFalse();
  expect(clicks).toBe(0);
});

test("owned recovery Send rechecks DOM at the cancellable Playwright click boundary", async () => {
  const { createWindow } = require("@mixmark-io/domino") as {
    createWindow(html: string): { document: Document; Event: typeof Event; HTMLButtonElement: typeof HTMLButtonElement };
  };
  const window = createWindow(`
    <article id="response"><div>tool result</div></article>
    <form><div id="composer" contenteditable="true">Recovery prompt</div><button id="send">Send</button></form>
  `);
  const composer = window.document.querySelector("#composer")!;
  const response = window.document.querySelector("#response")!;
  const button = window.document.querySelector("#send") as HTMLButtonElement;
  const form = button.closest("form")!;
  let applicationClicks = 0;
  form.addEventListener("click", event => { event.preventDefault(); applicationClicks += 1; });
  const locator = {
    evaluate: async (callback: (element: Element, input: unknown) => unknown, input: unknown) => callback(composer, input),
    locator: () => ({ locator: () => ({ click: async () => {
      response.innerHTML += "<p>Late final</p>";
      button.click();
    } }) }),
  };

  expect(await activateOwnedChatGptSendControl(locator as never, "Recovery prompt", "#send", {
    responseSelector: "#response",
    responseHtml: "<div>tool result</div>",
    stopButtonSelector: "#stop",
    deadlineAt: Date.now() + 10_000,
  })).toBeFalse();
  expect(applicationClicks).toBe(0);
});

test("owned recovery Send scopes every comma-separated selector branch to its nonce", async () => {
  const { createWindow } = require("@mixmark-io/domino") as {
    createWindow(html: string): { document: Document; HTMLButtonElement: typeof HTMLButtonElement };
  };
  const window = createWindow(`
    <article id="response"><div>tool result</div></article>
    <form><div id="composer" contenteditable="true">Recovery prompt</div>
      <button data-testid="send-button">Send</button><button type="submit">Alternate</button>
    </form>
  `);
  const composer = window.document.querySelector("#composer")!;
  const form = composer.closest("form")!;
  let applicationClicks = 0;
  form.addEventListener("click", event => { event.preventDefault(); applicationClicks += 1; });
  const locator = {
    evaluate: async (callback: (element: Element, input: unknown) => unknown, input: unknown) => callback(composer, input),
    locator: () => ({ locator: (selector: string) => ({ click: async () => {
      const replacement = window.document.createElement("button");
      replacement.setAttribute("data-testid", "send-button");
      form.querySelector('[data-testid="send-button"]')!.replaceWith(replacement);
      composer.textContent = "User draft";
      (form.querySelector(selector) as HTMLButtonElement | null)?.click();
    } }) }),
  };

  expect(await activateOwnedChatGptSendControl(
    locator as never,
    "Recovery prompt",
    '[data-testid="send-button"], button[type="submit"]',
    {
      responseSelector: "#response",
      responseHtml: "<div>tool result</div>",
      stopButtonSelector: "#stop",
      deadlineAt: Date.now() + 10_000,
    },
  )).toBeFalse();
  expect(applicationClicks).toBe(0);
});

test("owned recovery Send keeps its accepted receipt when the button remounts", async () => {
  const { createWindow } = require("@mixmark-io/domino") as {
    createWindow(html: string): { document: Document; HTMLButtonElement: typeof HTMLButtonElement };
  };
  const window = createWindow(`
    <article id="response"><div>tool result</div></article>
    <form><div id="composer" contenteditable="true">Recovery prompt</div><button id="send">Send</button></form>
  `);
  const composer = window.document.querySelector("#composer")!;
  const form = composer.closest("form")!;
  form.addEventListener("click", event => {
    event.preventDefault();
    composer.textContent = "";
    (event.target as Element).replaceWith(window.document.createElement("button"));
  });
  const locator = {
    evaluate: async (callback: (element: Element, input: unknown) => unknown, input: unknown) => callback(composer, input),
    locator: () => ({ locator: (selector: string) => ({ click: async () => {
      (form.querySelector(selector) as HTMLButtonElement | null)?.click();
    } }) }),
  };

  expect(await activateOwnedChatGptSendControl(locator as never, "Recovery prompt", "#send", {
    responseSelector: "#response",
    responseHtml: "<div>tool result</div>",
    stopButtonSelector: "#stop",
    deadlineAt: Date.now() + 10_000,
  })).toBeTrue();
  expect(composer.textContent).toBe("");
});

test("owned recovery Send reports unknown state when its receipt read fails after click", async () => {
  let evaluations = 0;
  let clicks = 0;
  const locator = {
    evaluate: async () => {
      evaluations += 1;
      if (evaluations === 1) return true;
      throw new Error("renderer receipt unavailable");
    },
    locator: () => ({ locator: () => ({ click: async () => { clicks += 1; } }) }),
  };

  await expect(activateOwnedChatGptSendControl(locator as never, "Recovery prompt", "#send", {
    responseSelector: "#response",
    responseHtml: "<div>tool result</div>",
    stopButtonSelector: "#stop",
    deadlineAt: Date.now() + 10_000,
  })).rejects.toBeInstanceOf(ChatGptOwnedSendStateUnknownError);
  expect(clicks).toBe(1);
});

test("owned recovery Send reports unknown state when its receipt disappears after click", async () => {
  const { createWindow } = require("@mixmark-io/domino") as {
    createWindow(html: string): { document: Document; HTMLButtonElement: typeof HTMLButtonElement };
  };
  const window = createWindow(`
    <article id="response"><div>tool result</div></article>
    <form><div id="composer" contenteditable="true">Recovery prompt</div><button id="send">Send</button></form>
  `);
  const composer = window.document.querySelector("#composer")!;
  const button = window.document.querySelector("#send") as HTMLButtonElement;
  let clicks = 0;
  button.addEventListener("click", event => { event.preventDefault(); clicks += 1; });
  const locator = {
    evaluate: async (
      callback: (element: Element, input: unknown) => boolean | undefined,
      input: unknown,
    ) => callback(composer, input),
    locator: () => ({ locator: () => ({ click: async () => {
      button.click();
      delete (window.document as Document & Record<string, unknown>).__codexRecoverySendGuards;
    } }) }),
  };

  await expect(activateOwnedChatGptSendControl(locator as never, "Recovery prompt", "#send", {
    responseSelector: "#response",
    responseHtml: "<div>tool result</div>",
    stopButtonSelector: "#stop",
    deadlineAt: Date.now() + 10_000,
  })).rejects.toBeInstanceOf(ChatGptOwnedSendStateUnknownError);
  expect(clicks).toBe(1);
});

test("owned recovery Send obeys an abort raised while renderer activation is pending", async () => {
  const { createWindow } = require("@mixmark-io/domino") as {
    createWindow(html: string): { document: Document; Event: typeof Event; HTMLButtonElement: typeof HTMLButtonElement };
  };
  const window = createWindow(`
    <article id="response"><div>tool result</div></article>
    <form><div id="composer" contenteditable="true">Recovery prompt</div><button id="send">Send</button></form>
  `);
  const composer = window.document.querySelector("#composer")!;
  const button = window.document.querySelector("#send") as HTMLButtonElement;
  const owner = new AbortController();
  let clicks = 0;
  button.addEventListener("click", event => { event.preventDefault(); clicks += 1; });
  const locator = {
    evaluate: async (
      callback: (element: Element, input: unknown) => boolean,
      input: unknown,
      _options: { signal?: AbortSignal },
    ) => {
      owner.abort(new DOMException("send stage expired", "AbortError"));
      // Playwright Locator.evaluate does not forward AbortSignal to the renderer call.
      return callback(composer, input);
    },
    locator: () => ({
      locator: () => ({
        click: async ({ signal }: { signal?: AbortSignal }) => signal?.throwIfAborted(),
      }),
    }),
  };

  await expect(activateOwnedChatGptSendControl(locator as never, "Recovery prompt", "#send", {
    responseSelector: "#response",
    responseHtml: "<div>tool result</div>",
    stopButtonSelector: "#stop",
    deadlineAt: Date.now() + 10_000,
  }, owner.signal)).rejects.toBe(owner.signal.reason);
  expect(clicks).toBe(0);
  expect(button.hasAttribute("data-codex-recovery-send")).toBeFalse();
  const registry = (window.document as Document & Record<string, unknown>).__codexRecoverySendGuards as Record<string, unknown>;
  expect(Object.keys(registry)).toHaveLength(0);
});

test("owned recovery Send does not activate after its stage deadline", async () => {
  let evaluated = false;
  const locator = {
    evaluate: async (callback: (element: Element, input: unknown) => boolean, input: unknown) => {
      evaluated = true;
      return callback({} as Element, input);
    },
  };

  expect(await activateOwnedChatGptSendControl(locator as never, "Recovery prompt", "#send", {
    responseSelector: "#response",
    responseHtml: "",
    stopButtonSelector: "#stop",
    deadlineAt: Date.now() - 1,
  })).toBeFalse();
  expect(evaluated).toBeTrue();
});

test("assistant identity detects a virtualized retained response without count growth", () => {
  expect(chatGptAssistantTurnChanged(
    { count: 3, lastId: "conversation-turn-7" },
    { count: 3, lastId: "conversation-turn-9" },
  )).toBeTrue();
});

test("assistant identity does not bind an unchanged historical response", () => {
  expect(chatGptAssistantTurnChanged(
    { count: 3, lastId: "conversation-turn-7" },
    { count: 3, lastId: "conversation-turn-7" },
  )).toBeFalse();
  expect(chatGptAssistantTurnChanged({ count: 3 }, { count: 3 })).toBeFalse();
});

test("assistant count growth remains conclusive submission evidence", () => {
  expect(chatGptAssistantTurnChanged(
    { count: 2, lastId: "conversation-turn-5" },
    { count: 3, lastId: "conversation-turn-7" },
  )).toBeTrue();
  expect(chatGptSubmissionEvidence({
    initialUserTurnCount: 1,
    userTurnCount: 1,
    initialAssistantTurnCount: 2,
    assistantTurnCount: 3,
    initialAssistantTurnId: "conversation-turn-5",
    assistantTurnId: "conversation-turn-7",
    generationRunning: false,
  })).toBe("assistant_turn");
});

test("virtualization expansion with the same assistant identity is not submission evidence", () => {
  expect(chatGptAssistantTurnChanged(
    { count: 2, lastId: "conversation-turn-7" },
    { count: 3, lastId: "conversation-turn-7" },
  )).toBeFalse();
  expect(bindChatGptAssistantTurn(
    { count: 2, lastId: "conversation-turn-7" },
    { count: 3, lastId: "conversation-turn-7" },
  )).toBeUndefined();
  expect(chatGptSubmissionEvidence({
    initialUserTurnCount: 1,
    userTurnCount: 1,
    initialAssistantTurnCount: 2,
    assistantTurnCount: 3,
    initialAssistantTurnId: "conversation-turn-7",
    assistantTurnId: "conversation-turn-7",
    generationRunning: false,
  })).toBeUndefined();
});

test("reads assistant count and public identity from one DOM snapshot", async () => {
  let snapshots = 0;
  const turns = {
    evaluateAll(callback: (elements: Array<{ getAttribute(name: string): string | null }>) => unknown) {
      snapshots += 1;
      return Promise.resolve(callback([
        { getAttribute: (name: string) => name === "data-turn-id" ? "conversation-turn-5" : null },
        { getAttribute: (name: string) => name === "data-turn-id" ? "conversation-turn-7" : null },
      ]));
    },
  };

  expect(await readChatGptAssistantTurnState(turns as never)).toEqual({
    count: 2,
    lastId: "conversation-turn-7",
    identities: ["conversation-turn-5", "conversation-turn-7"],
  });
  expect(snapshots).toBe(1);
});

test("assistant identity change is conclusive submission evidence when count stays fixed", () => {
  expect(chatGptSubmissionEvidence({
    initialUserTurnCount: 1,
    userTurnCount: 1,
    initialAssistantTurnCount: 3,
    assistantTurnCount: 3,
    initialAssistantTurnId: "conversation-turn-7",
    assistantTurnId: "conversation-turn-9",
    generationRunning: false,
  })).toBe("assistant_turn");
});

test("assistant identity churn during virtualization shrink is not submission evidence", () => {
  expect(chatGptAssistantTurnChanged(
    { count: 3, lastId: "conversation-turn-7" },
    { count: 2, lastId: "conversation-turn-5" },
  )).toBeFalse();
  expect(chatGptSubmissionEvidence({
    initialUserTurnCount: 1,
    userTurnCount: 1,
    initialAssistantTurnCount: 3,
    assistantTurnCount: 2,
    initialAssistantTurnId: "conversation-turn-7",
    assistantTurnId: "conversation-turn-5",
    generationRunning: false,
  })).toBeUndefined();
});

test("binds the submitted response to its public assistant turn identity", () => {
  expect(bindChatGptAssistantTurn(
    { count: 3, lastId: "conversation-turn-7" },
    { count: 4, lastId: "conversation-turn-9" },
  )).toEqual({ id: "conversation-turn-9", ordinal: 3, generation: 0 });
});

test("does not bind a submitted response until a stable public identity is available", () => {
  expect(bindChatGptAssistantTurn(
    { count: 3, lastId: "conversation-turn-7" },
    { count: 4 },
  )).toBeUndefined();
});

test("locates a bound assistant response exclusively by its stable public identity", () => {
  const resolved = {} as never;
  let observedId = "";
  const turns = {
    page: () => ({
      locator(selector: string) {
        observedId = selector;
        return resolved;
      },
    }),
    nth: () => { throw new Error("ordinal fallback must not be used"); },
  };

  expect(locateChatGptAssistantTurn(turns as never, {
    id: "conversation-turn-9",
    ordinal: 3,
    generation: 0,
  })).toBe(resolved);
  expect(observedId).toBe('[data-turn-id="conversation-turn-9"]');
});

test("keeps an attached response binding when historical turns are virtualized", () => {
  const binding = { id: "conversation-turn-9", ordinal: 3, generation: 0 };
  expect(reconcileChatGptAssistantTurnBinding(
    { count: 3, lastId: "conversation-turn-7" },
    { count: 2, lastId: "conversation-turn-9" },
    binding,
    true,
  )).toEqual(binding);
});

test("recovers a detached binding by public identity after virtualization shrink", () => {
  const binding = { id: "conversation-turn-9", ordinal: 3, generation: 0 };
  expect(reconcileChatGptAssistantTurnBinding(
    { count: 3, lastId: "conversation-turn-7" },
    { count: 2, lastId: "conversation-turn-9" },
    binding,
    false,
  )).toEqual({ ...binding, ordinal: 1 });
});

test("rebinds a detached response only to a new post-submission assistant identity", () => {
  expect(reconcileChatGptAssistantTurnBinding(
    { count: 3, lastId: "conversation-turn-7" },
    { count: 3, lastId: "conversation-turn-11" },
    { id: "conversation-turn-9", ordinal: 3, generation: 0 },
    false,
  )).toEqual({ id: "conversation-turn-11", ordinal: 2, generation: 1 });

  expect(reconcileChatGptAssistantTurnBinding(
    { count: 3, lastId: "conversation-turn-7" },
    { count: 3, lastId: "conversation-turn-7" },
    { id: "conversation-turn-9", ordinal: 3, generation: 0 },
    false,
  )).toBeUndefined();
});
