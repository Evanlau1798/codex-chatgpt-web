import { expect, test } from "bun:test";
import {
  activateChatGptSendControl,
  bindChatGptAssistantTurn,
  chatGptAssistantTurnChanged,
  chatGptNewTurnIdentity,
  chatGptSubmissionEvidence,
  locateChatGptAssistantTurn,
  ChatGptTurnIdentityAmbiguityError,
  readChatGptAssistantTurnState,
  readChatGptTurnIdentities,
  reconcileChatGptAssistantTurnBinding,
} from "../src/adapters/chatgpt-web/response-turn-boundary";

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

test("send control uses semantic keyboard activation", async () => {
  const activations: string[] = [];
  await activateChatGptSendControl({
    press: async key => { activations.push(key); },
  });
  expect(activations).toEqual(["Enter"]);
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
