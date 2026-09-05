import { expect, test } from "bun:test";
import {
  assertChatGptWebMultipartInputWithinLimits,
  prepareChatGptWebMultipartTransport,
  resolveChatGptWebMultipartStagingMode,
} from "../src/adapters/chatgpt-web/multipart-browser-transport";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { CodexParsedRequest } from "../src/types";

const pro = { localToolsEnabled: false, solAvailable: true, proAvailable: true };

function request(): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: false,
    context: {
      systemPrompt: ["system"],
      messages: [
        { role: "developer", content: "developer", timestamp: 1 },
        { role: "user", content: "perform the task", timestamp: 2 },
      ],
      tools: [],
    },
    options: { reasoning: "high" },
  };
}

test("Bigger Context expands only the total ceiling and preserves per-message boundaries", () => {
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    280_000, 95_000, CHATGPT_WEB_MODEL_ID, "high", pro, 900_000, 3,
  )).not.toThrow();
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    333_579, 95_000, CHATGPT_WEB_MODEL_ID, "high", pro, 900_000, 3,
  )).toThrow("three-part ceiling");
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    222_386, 95_000, CHATGPT_WEB_MODEL_ID, "high", pro, 900_000, 2,
  )).toThrow("two-part ceiling");
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    20_000,
    10_000,
    "gpt-5.6-luna",
    "low",
    { localToolsEnabled: false, solAvailable: false, proAvailable: false },
    40_000,
    2,
  )).toThrow("unavailable for Luna");
});

test("Bigger Context selects the cheapest account mode that can carry every stage", () => {
  const plus = { localToolsEnabled: false, solAvailable: true, proAvailable: false };
  expect(resolveChatGptWebMultipartStagingMode(CHATGPT_WEB_MODEL_ID, plus, 30_000, 200_000).effort)
    .toBe("low");
  expect(resolveChatGptWebMultipartStagingMode(CHATGPT_WEB_MODEL_ID, pro, 100_000, 500_000).effort)
    .toBe("low");
  expect(resolveChatGptWebMultipartStagingMode(CHATGPT_WEB_MODEL_ID, pro, 104_000, 1_200_000).effort)
    .toBe("max");
});

test("Bigger Context transport stages inert parts and executes only from the final message", () => {
  const compiled = compileChatGptWebPrompt(request(), pro, undefined, { experimentalMultipartParts: 3 });
  const prepared = prepareChatGptWebMultipartTransport(
    compiled,
    CHATGPT_WEB_MODEL_ID,
    { ...pro, localToolsEnabled: false },
    "high",
  );
  expect(prepared).toBeDefined();
  expect(prepared!.stages).toHaveLength(2);
  expect(prepared!.stages[0]!.text).toContain("<codex_multipart_stage>");
  expect(prepared!.stages[0]!.acknowledgement).toContain("CODEX_MULTIPART_ACK");
  expect(prepared!.finalPrompt).toContain("<codex_multipart_execute>");
  expect(prepared!.finalPrompt).toContain("perform the task");
  expect(prepared!.stagingMode.effort).toBe("low");
});
