import { expect, test } from "bun:test";
import {
  availableChatGptWebModelRoutes, parseChatGptWebModelCapabilities,
  resolveChatGptWebContextLimits, CHATGPT_WEB_BACKEND_MODEL,
} from "../src/chatgpt-web-models";
import { assertChatGptWebInputWithinLimits } from "../src/adapters/chatgpt-web/transport-budget";

test("GPT-6.2 observed effort capabilities survive persisted validation without granting extra efforts", () => {
  const evidence = { observedAt: 1234, families: { "6.2": ["low", "medium", "high"] as const } };
  const modelCapabilities = parseChatGptWebModelCapabilities(JSON.parse(JSON.stringify(evidence)));
  expect(modelCapabilities).toEqual(evidence);
  const routes = availableChatGptWebModelRoutes({ solAvailable: true, proAvailable: false,
    extraHighAvailable: false, modelCapabilities });
  expect(routes.some(route => route.slug === "chatgpt-web/gpt-6.2-sol")).toBe(true);
  expect(() => parseChatGptWebModelCapabilities({ ...evidence, families: { "6.3": ["high"] } })).toThrow();
});

test.each(["medium", "high", "xhigh"] as const)("GPT-6.2 retains Enhanced reasoning budgets at %s", effort => {
  const capabilities = { solAvailable: true, proAvailable: true, extraHighAvailable: true };
  expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, effort, capabilities, true, "6.2"))
    .toEqual(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, effort, capabilities, true, "6"));
});

test("GPT-6.2 Instant applies its own composer ceiling before submission", () => {
  const caps = { localToolsEnabled: false, solAvailable: true, proAvailable: true, extraHighAvailable: true };
  expect(() => assertChatGptWebInputWithinLimits(10_000, 10_000, CHATGPT_WEB_BACKEND_MODEL,
    "low", caps, 520_000, false, "6.2")).toThrow("composer boundary");
  expect(() => assertChatGptWebInputWithinLimits(10_000, 10_000, CHATGPT_WEB_BACKEND_MODEL,
    "low", caps, 520_000, false, "6")).not.toThrow();
});
