import { expect, test } from "bun:test";
import { defaultConfig, type AppConfig } from "../src/config";
import { compactRequest, routeChatGptWebRequest } from "../src/server";
import { parseRequest } from "../src/responses/parser";
import { estimateChatGptWebInputTokens } from "../src/adapters/chatgpt-web/usage";
import { resolveChatGptWebContextLimits } from "../src/chatgpt-web-models";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";

const user = (text: string, id = "latest") => ({ type: "message", role: "user", id, content: text });
const capabilities = { localToolsEnabled: true, solAvailable: true, proAvailable: false };

async function compact(raw: Record<string, unknown>, summary: string, config = defaultConfig("full")) {
  let calls = 0;
  const response = await compactRequest(new Request("http://localhost/v1/responses/compact", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(raw),
  }), config, () => ({
    name: "bounded-checkpoint",
    async runTurn(_parsed, _incoming, emit) {
      calls += 1;
      emit({ type: "text_delta", text: summary, phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));
  expect(calls).toBe(1);
  return response;
}

function measure(raw: Record<string, unknown>, output: unknown[], config: AppConfig) {
  const parsed = parseRequest({ ...raw, input: output });
  const route = routeChatGptWebRequest(parsed, config);
  return {
    tokens: estimateChatGptWebInputTokens(parsed, { ...capabilities, proAvailable: config.proAvailable }),
    limit: resolveChatGptWebContextLimits(route.backendModel, route.adapterEffort, config,
      config.useEnhancedWebSessionMode).autoCompactTokenLimit,
  };
}

test("usage estimates a full-mode request with no authorized tools", () => {
  const parsed = parseRequest({ model: "chatgpt-web/medium", input: [user("Inspect only.")] });
  routeChatGptWebRequest(parsed, defaultConfig("full"));
  expect(estimateChatGptWebInputTokens(parsed, capabilities)).toBeGreaterThan(8192);
});

test("Enhanced estimates use the same native-control contract as production compilation", () => {
  const parsed = parseRequest({ model: "chatgpt-web/medium", input: [user("Inspect only.")] });
  routeChatGptWebRequest(parsed, defaultConfig("full"));
  const options = { nativeControlConnector: true };
  const compiled = compileChatGptWebPrompt(parsed, capabilities, undefined, options);
  expect(estimateChatGptWebInputTokens(parsed, capabilities, options))
    .toBe(estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId));
});

test("irreducible replacement fails once without a partial history", async () => {
  const raw = { model: "chatgpt-web/medium", input: [user("Inspect only.")] };
  const response = await compact(raw, "checkpoint ".repeat(85_000));
  expect(response.status).toBe(400);
  const body = await response.json() as { output?: unknown; error: { code: string } };
  expect(body.output).toBeUndefined();
  expect(body.error.code).toBe("compaction_budget_exceeded");
});

test("full replacement budget includes instructions and drops optional history first", async () => {
  const config = defaultConfig("full");
  const raw = {
    model: "chatgpt-web/medium",
    instructions: "instruction ".repeat(53_000),
    input: [user("previous ".repeat(18_000), "older"), user("Cancel deployment. Inspect only.")],
  };
  const response = await compact(raw, "checkpoint ".repeat(8_000), config);
  expect(response.status).toBe(200);
  const { output } = await response.json() as { output: Array<{ id?: string }> };
  expect(output.some(item => item.id === "older")).toBe(false);
  expect(output.some(item => item.id === "latest")).toBe(true);
  const budget = measure(raw, output, config);
  expect(budget.tokens).toBeLessThan(budget.limit);
});

test.each([
  ["chatgpt-web/medium", false, false],
  ["chatgpt-web/pro", true, false],
  ["chatgpt-web/medium", true, true],
  ["chatgpt-web/zero-risk", false, false],
  ["chatgpt-web/zero-risk-pro", true, false],
] as const)("replacement estimates the actual %s route", async (model, pro, enhanced) => {
  const config = defaultConfig("full");
  config.proAvailable = pro;
  config.useEnhancedWebSessionMode = enhanced;
  if (model.includes("zero-risk")) {
    config.browserInteractionMode = "manual";
    config.zeroRiskProEnabled = pro;
  }
  const raw = { model, input: [user("Continue the current task.")], tools: [
    { type: "function", name: "inspect", parameters: { type: "object", properties: {} } },
  ] };
  const response = await compact(raw, "Checkpoint: inspect the pending change.", config);
  expect(response.status).toBe(200);
  const { output } = await response.json() as { output: unknown[] };
  const budget = measure(raw, output, config);
  expect(budget.tokens).toBeLessThan(budget.limit);
});

test("inventory-only tool descriptions do not inflate the compiled prompt budget", async () => {
  const raw = { model: "chatgpt-web/medium", input: [user("Inspect only.")], tools: [
    { type: "function", name: "inspect", description: "schema ".repeat(85_000),
      parameters: { type: "object", properties: {} } },
  ] };
  const config = defaultConfig("full");
  const response = await compact(raw, "Inspect only.", config);
  expect(response.status).toBe(200);
  const { output } = await response.json() as { output: unknown[] };
  const huge = measure(raw, output, config);
  raw.tools[0]!.description = "Inspect the task.";
  expect(measure(raw, output, config).tokens).toBe(huge.tokens);
});

test("100 production compact cycles stay bounded in a hypothetical 200k window", async () => {
  const config = defaultConfig("full");
  let input: unknown[] = [user("Continue the current task.")];
  let baseline = 0;
  for (let cycle = 0; cycle < 100; cycle++) {
    const raw = { model: "chatgpt-web/medium", input };
    const response = await compact(raw, "Verified checkpoint. Continue pending work.", config);
    expect(response.status).toBe(200);
    input = (await response.json() as { output: unknown[] }).output;
    const { tokens } = measure(raw, input, config);
    if (cycle === 0) baseline = tokens;
    expect(tokens).toBe(baseline);
    expect(200_000 - tokens).toBeGreaterThan(0);
  }
  const parsed = parseRequest({ model: "chatgpt-web/medium", input });
  routeChatGptWebRequest(parsed, config);
  parsed.context.messages.push({ role: "user", content: "file evidence ".repeat(20_000), timestamp: 1 });
  expect(estimateChatGptWebInputTokens(parsed, capabilities)).toBeGreaterThan(baseline + 20_000);
  // New evidence consumes context; repeated compact alone did not inflate the baseline.
  console.info(JSON.stringify({ scenario: "compact-100", cycles: 100, context_window: 200_000,
    estimated_input_tokens: baseline, remaining_tokens: 200_000 - baseline }));
}, 15_000);
