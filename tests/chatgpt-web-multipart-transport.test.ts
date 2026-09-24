import { expect, spyOn, test } from "bun:test";
import {
  assertChatGptWebMultipartInputWithinLimits,
  prepareChatGptWebMultipartTransport,
  resolveChatGptWebMultipartStagingMode,
} from "../src/adapters/chatgpt-web/multipart-browser-transport";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptBrowserDiagnostics } from "../src/adapters/chatgpt-web/browser-diagnostics";
import { planChatGptPromptInsertion } from "../src/adapters/chatgpt-web/prompt-insertion-plan";
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
    280_000, 95_000, CHATGPT_WEB_MODEL_ID, "high", pro, 450_000, 6,
  )).not.toThrow();
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    333_579, 95_000, CHATGPT_WEB_MODEL_ID, "high", pro, 450_000, 6,
  )).toThrow("six-part ceiling");
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    222_386, 95_000, CHATGPT_WEB_MODEL_ID, "high", pro, 450_000, 2,
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
  const compiled = compileChatGptWebPrompt(request(), pro, undefined, { experimentalMultipartParts: 6 });
  const prepared = prepareChatGptWebMultipartTransport(
    compiled,
    CHATGPT_WEB_MODEL_ID,
    { ...pro, localToolsEnabled: false },
    "high",
  );
  expect(prepared).toBeDefined();
  expect(prepared!.stages).toHaveLength(5);
  expect(prepared!.stages[0]!.text).toContain("<codex_multipart_stage>");
  expect(prepared!.stages[0]!.acknowledgement).toContain("CODEX_MULTIPART_ACK");
  expect(prepared!.finalPrompt).toContain("<codex_multipart_execute>");
  expect(prepared!.finalPrompt).toContain("perform the task");
  expect(prepared!.stagingMode.effort).toBe("low");
});

test("large Bigger Context stage reaches the verified direct attachment route by default", async () => {
  const parsed = request();
  parsed.context.systemPrompt = Array.from({ length: 4 }, (_, i) => `system ${i} ${"dense *markdown* [link](x)\n".repeat(1_500)}`);
  parsed.context.messages[0]!.content = `developer ${"middle *markdown* [link](x)\n".repeat(1_500)}`;
  parsed.context.messages[1]!.content = `perform the task ${"final *markdown* [link](x)\n".repeat(1_500)}`;
  const compiled = compileChatGptWebPrompt(parsed, pro, undefined, { experimentalMultipartParts: 6 });
  const failure = new Error("attachment intercepted");
  const capture = spyOn(ChatGptBrowserDiagnostics.prototype, "capture").mockImplementation(async () => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  const stages: Array<{ text: string; direct: boolean }> = [];
  let final: { text: string; direct: boolean } | undefined;
  const page = {
    isClosed: () => false,
    locator: () => ({ count: async () => 0, nth() { return this; },
      evaluateAll: async () => ({ count: 0, identities: [], ambiguous: false }) }),
  };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: {},
    finalizingRuns: new Set<string>(),
    runStage: async (_trace: string, _stage: string, _timeout: number,
      action: (signal: AbortSignal, remaining: () => number) => Promise<unknown>) =>
      action(new AbortController().signal, () => 90_000),
    prepareChatSurface: async () => {},
    selectModelAndEffort: async () => ({ effort: "low", localTools: false }),
    attachPrompt: async (_page: unknown, text: string, _tools: boolean, _capture: unknown,
      _signal: unknown, _catalog: unknown, _budget: unknown, _think: unknown, direct: boolean) => {
      stages.push({ text, direct });
    },
    sendAttachedPrompt: async () => "user_turn",
    waitForNewAssistantTurn: async () => ({}),
    waitForMultipartAcknowledgement: async () => {},
    attachPromptWithCompactionRetry: async (...args: unknown[]) => {
      final = { text: args[1] as string, direct: args[10] as boolean };
      throw failure;
    },
  });
  try {
    await expect(worker.runBrowserTurn({
      traceId: "multipart_direct_fixture", modelId: CHATGPT_WEB_MODEL_ID,
      reasoning: "high", capabilities: pro,
      prepare: async () => ({ ...compiled, release: () => {} }),
      onTextDelta: () => {},
    }, undefined, page)).rejects.toBe(failure);
    expect(stages).toHaveLength(5);
    for (const stage of stages) {
      expect(stage.text.length).toBeGreaterThan(32_000);
      expect(planChatGptPromptInsertion(stage.text, { largeStructuredDirect: stage.direct }).strategy)
        .toBe("direct-html-prewrap");
    }
    expect(final?.text.length).toBeGreaterThan(32_000);
    expect(planChatGptPromptInsertion(final!.text, { largeStructuredDirect: final!.direct }).strategy)
      .toBe("direct-html-prewrap");
  } finally {
    capture.mockRestore();
    error.mockRestore();
  }
});
