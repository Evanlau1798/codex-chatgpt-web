import { expect, test } from "bun:test";
import { createDocument } from "@mixmark-io/domino";
import { CHATGPT_ASSISTANT_TURN_SELECTOR, CHATGPT_USER_TURN_SELECTOR } from "../src/chatgpt-session";
import { bindChatGptSubmissionIdentity, chatGptSubmissionIdentityMatches } from "../src/adapters/chatgpt-web/submission-identity";
import {
  bindChatGptAssistantTurn,
  chatGptAssistantTurnChanged,
  chatGptNewTurnIdentity,
  chatGptReboundTurnIdentity,
  chatGptSubmissionEvidence,
  readChatGptAssistantTurnState,
  readChatGptTurnIdentities,
} from "../src/adapters/chatgpt-web/response-turn-boundary";

function surface(keys: string[]) {
  const document = createDocument(keys.map(key => `<section data-turn-key="${key}">
    <div data-user-message-bubble></div><h4 data-conversation-role="assistant"></h4>
  </section>`).join(""));
  const page = { locator: (selector: string): any => ({
    page: () => page,
    evaluateAll: async (callback: Function, argument?: unknown) =>
      callback([...document.querySelectorAll(selector)], argument),
  }) };
  return {
    assistant: () => readChatGptAssistantTurnState(page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR)),
    users: () => readChatGptTurnIdentities(page.locator(CHATGPT_USER_TURN_SELECTOR)),
  };
}

test("read-only submission identity preserves literal context, release ownership and transport accounting", () => {
  const text = 'Literal `code` <context> C:\\repo\\file\n  Keep spaces.';
  const release = () => {};
  const original = { text, images: [], modelInputText: text, inlineChars: text.length,
    multipart: { parts: ['{"record":1}', '{"record":2}'], commit: "Execute now" }, release };
  const { prepared, identity } = bindChatGptSubmissionIdentity(original);
  expect(identity).toMatch(/^codexsubmission:[a-f0-9]{32}$/);
  expect(prepared.text).toBe(text + "\n" + identity);
  expect(prepared.modelInputText).toBe(prepared.text);
  expect(prepared.inlineChars).toBe(prepared.text.length);
  expect(prepared.multipart.commit).toBe("Execute now\n" + identity);
  expect(prepared.multipart.parts).toBe(original.multipart.parts);
  expect(prepared.release).toBe(release);
  expect(original.text).toBe(text);
  expect(original.multipart.commit).toBe("Execute now");
  expect(bindChatGptSubmissionIdentity(original).identity).not.toBe(identity);
  expect("turnToken" in prepared).toBeFalse();
});

test("Native submissions retain their existing capability and prompt without another identity", () => {
  const original = { text: "Bound prompt", images: [], turnToken: "turn_0123456789abcdef0123456789abcdef" };
  const result = bindChatGptSubmissionIdentity(original);
  expect(result.prepared).toBe(original);
  expect(result.identity).toBeUndefined();
});

test("literal context may contain other non-authorizing identity examples", () => {
  const own = "codexsubmission:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const example = "codexsubmission:0123456789abcdef0123456789abcdef";
  const node = (textContent: string) => ({ textContent }) as Element;
  const literal = `Review this source example: "${example}".\n`;
  expect(chatGptSubmissionIdentityMatches(node(literal + own), own)).toBeTrue();
  expect(chatGptSubmissionIdentityMatches(node(literal), own)).toBeFalse();
  expect(chatGptSubmissionIdentityMatches(node(literal + own + " " + own), own)).toBeFalse();
  const native = "turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  expect(chatGptSubmissionIdentityMatches(node(native + " turn_0123456789abcdef0123456789abcdef"), native)).toBeFalse();
});

test("submission identity proof rejects ambiguous and incomplete identities without granting tools", () => {
  for (const identity of ["turn_0123456789abcdef0123456789abcdef", "codexsubmission:0123456789abcdef0123456789abcdef"]) {
    const node = (textContent: string) => ({ textContent }) as Element;
    expect(chatGptSubmissionIdentityMatches(node("Rewritten JSON/link labels. " + identity), identity)).toBeTrue();
    for (const text of ["", identity + "extra", "prefix" + identity, identity + "_tail", "prefix_" + identity, identity + " " + identity]) {
      expect(chatGptSubmissionIdentityMatches(node(text), identity)).toBeFalse();
    }
    expect(chatGptSubmissionIdentityMatches(node(identity), "arbitrary identity")).toBeFalse();
  }
});

test("restored history before the retained anchor does not interrupt an accepted tool response", async () => {
  const initial = await surface(["visible"]).assistant();
  const expanded = surface(["restored-history", "visible", "submitted"]);
  const current = await expanded.assistant();
  expect(chatGptAssistantTurnChanged(initial, current)).toBeTrue();
  expect(bindChatGptAssistantTurn(initial, current)).toEqual({
    id: "group:assistant:submitted", ordinal: 2, generation: 0,
  });
  expect(chatGptSubmissionEvidence({
    initialUserTurnCount: 1, userTurnCount: 3,
    initialAssistantTurnCount: initial.count, assistantTurnCount: current.count,
    initialTurnIdentities: initial.knownTurnIdentities,
    userIdentities: await expanded.users(), responseIdentities: current.identities,
    generationRunning: true,
  })).toBe("user_turn");
  expect(chatGptReboundTurnIdentity(initial.knownTurnIdentities!, "detached", current.identities!))
    .toBe("group:assistant:submitted");
});

test("history restoration alone is not a new response or submission", async () => {
  const initial = await surface(["visible"]).assistant();
  const current = await surface(["restored-history", "visible"]).assistant();
  expect(chatGptAssistantTurnChanged(initial, current)).toBeFalse();
  expect(bindChatGptAssistantTurn(initial, current)).toBeUndefined();
});

test("two additions after the anchor still reject a duplicated submission", async () => {
  const initial = await surface(["visible"]).assistant();
  const current = await surface(["restored-history", "visible", "submitted", "foreign"]).assistant();
  expect(() => chatGptAssistantTurnChanged(initial, current)).toThrow("2 new conversation turns");
});

test("an absent anchor does not authorize ignoring unknown history", () => {
  expect(() => chatGptNewTurnIdentity(["visible"], ["restored-history", "submitted"]))
    .toThrow("2 new conversation turns");
});

test("retained identity reordering cannot establish a history boundary", () => {
  expect(() => chatGptNewTurnIdentity(["old-1", "old-2"], ["old-2", "old-1", "submitted"]))
    .toThrow("history order changed");
});

test("a retained older anchor remains usable when newer known history is virtualized", () => {
  expect(chatGptNewTurnIdentity(["old-1", "old-2"], ["restored-history", "old-1", "submitted"]))
    .toBe("submitted");
});
