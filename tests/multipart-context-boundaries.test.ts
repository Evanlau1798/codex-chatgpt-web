import { expect, test } from "bun:test";
import { assertChatGptWebMultipartInputWithinLimits, resolveChatGptWebMultipartStagingMode } from "../src/adapters/chatgpt-web/multipart-browser-transport";

test("Bigger Context preflight expands only the total context ceiling and keeps each message boundary", () => {
  const plus = {
    localToolsEnabled: false,
    solAvailable: true,
    proAvailable: false,
    experimentalBiggerContext: true,
  };
  const pro = {
    localToolsEnabled: false,
    solAvailable: true,
    proAvailable: true,
    experimentalBiggerContext: true,
  };
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    333_578,
    95_000,
    "gpt-5.6-sol",
    "high",
    pro,
    900_000,
    3,
  )).not.toThrow();
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    333_579,
    95_000,
    "gpt-5.6-sol",
    "high",
    pro,
    900_000,
    3,
  )).toThrow("three-part ceiling");
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    222_385,
    95_000,
    "gpt-5.6-sol",
    "high",
    pro,
    900_000,
    2,
  )).not.toThrow();
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    222_386,
    95_000,
    "gpt-5.6-sol",
    "high",
    pro,
    900_000,
    2,
  )).toThrow("two-part ceiling");
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    269_999,
    80_000,
    "gpt-5.6-sol",
    "high",
    plus,
    900_000,
    3,
  )).not.toThrow();
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    270_000,
    80_000,
    "gpt-5.6-sol",
    "high",
    plus,
    900_000,
    3,
  )).toThrow("270,000-token three-part ceiling");
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    180_000,
    80_000,
    "gpt-5.6-sol",
    "high",
    plus,
    900_000,
    2,
  )).toThrow("180,000-token two-part ceiling");
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    280_000,
    103_001,
    "gpt-5.6-sol",
    "high",
    pro,
    900_000,
    3,
  )).toThrow("ChatGPT message boundary");
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

test("Bigger Context stages use the lowest account mode that can carry the stage", () => {
  const plus = { localToolsEnabled: false, solAvailable: true, proAvailable: false };
  const pro = { localToolsEnabled: false, solAvailable: true, proAvailable: true };
  expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", plus, "medium", 30_000, 200_000).effort).toBe("medium");
  expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", plus, "high", 30_000, 300_000).effort).toBe("medium");
  expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", pro, "medium", 100_000, 500_000).effort).toBe("low");
  expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", pro, "medium", 100_000, 600_000).effort).toBe("medium");
  expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", pro, "max", 104_000, 1_200_000).effort).toBe("max");
  expect(() => resolveChatGptWebMultipartStagingMode(
    "gpt-5.6-luna",
    { localToolsEnabled: false, solAvailable: false, proAvailable: false },
    "low",
    10_000,
    20_000,
  )).toThrow("Luna-only");
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    100_000,
    30_000,
    "gpt-5.6-sol",
    "low",
    plus,
    300_000,
    3,
    {
      stagingEffort: "medium",
      maxStageMessageTokens: 30_000,
      maxStageChars: 300_000,
      finalMessageTokens: 1_000,
      finalMessageChars: 4_000,
    },
  )).not.toThrow();
});
