import { expect, test } from "bun:test";
import {
  compileChatGptWebPrompt,
  type CompiledChatGptWebPrompt,
} from "../src/adapters/chatgpt-web/prompt";
import { estimateChatGptWebImageTokens, estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { prepareChatGptWebMultipartTransport as prepareChatGptMultipartProduction } from "../src/adapters/chatgpt-web/multipart-browser-transport";
import { CHATGPT_WEB_PLATFORM_RESERVE_TOKENS, resolveChatGptWebMultipartContextWindow } from "../src/chatgpt-web-models";
import { skillFileTokens } from "../src/adapters/chatgpt-web/skill-attachments";
import { estimateTokens } from "../src/lib/token-estimate";
import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "../src/adapters/chatgpt-web/model";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import type { CodexParsedRequest } from "../src/types";

const capabilities: ChatGptWebCapabilities = {
  localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true,
};
const turnToken = `turn_${"0".repeat(32)}`;

function request(): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    _chatgptModelFamily: "6",
    _compactionRequest: true,
    context: { systemPrompt: ["preserve system instructions"], messages: [],
      tools: [{ name: "read", description: "Read a file", parameters: {} }] },
    stream: false,
    options: { reasoning: "xhigh" },
  };
}

function assertMultipartFits(
  compiled: CompiledChatGptWebPrompt,
  parsed: CodexParsedRequest,
  caps = capabilities,
): void {
  const prepared = prepareChatGptMultipartProduction(compiled, parsed.modelId, caps,
    resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, caps).effort, parsed._chatgptModelFamily);
  expect(prepared).toBeDefined();
  expect(prepared!.stages).toHaveLength(compiled.multipart!.parts.length - 1);
  expect(prepared!.finalPrompt).toContain("<codex_multipart_execute>");
  expect(actualMultipartTokens(compiled, parsed, prepared!)).toBeLessThan(ceiling(parsed, compiled.multipart!.parts.length, caps));
}

function actualMultipartTokens(
  compiled: CompiledChatGptWebPrompt,
  parsed: CodexParsedRequest,
  prepared: NonNullable<ReturnType<typeof prepareChatGptMultipartProduction>>,
): number {
  return CHATGPT_WEB_PLATFORM_RESERVE_TOKENS
    + prepared.stageMessageTokens.reduce((sum, tokens) => sum + tokens, 0)
    + prepared.stages.reduce((sum, stage) => sum + estimateTokens(stage.acknowledgement, parsed.modelId), 0)
    + estimateTokens(prepared.finalPrompt, parsed.modelId)
    + estimateChatGptWebImageTokens(compiled) + skillFileTokens(compiled.skillFiles, parsed.modelId);
}

function ceiling(parsed: CodexParsedRequest, parts = 6, caps = capabilities): number {
  return resolveChatGptWebMultipartContextWindow(parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID
    ? CHATGPT_WEB_LUNA_MODEL_ID : CHATGPT_WEB_MODEL_ID,
    resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, caps).effort,
    caps, parts, parsed._chatgptModelFamily);
}

test.each(["string", "text parts"] as const)("#930: GPT-6 Pro compaction recovers above the six-part ceiling (%s checkpoint)", checkpointFormat => {
  const parsed = request();
  const checkpoint = `${SUMMARY_PREFIX}\nVerified cumulative progress and pending work`;
  parsed.context.messages = [
    { role: "user", content: `${SUMMARY_PREFIX}\nObsolete checkpoint`, timestamp: 1 },
    { role: "user", content: checkpointFormat === "text parts"
      ? checkpoint.split("\n").map(text => ({ type: "text" as const, text })) : checkpoint, timestamp: 2 },
    ...Array.from({ length: 12 }, (_, index) => ({
      role: "toolResult" as const, toolCallId: `read-${index}`, toolName: "read", isError: false,
      content: `history-${index} ${"word ".repeat(22_000)}`, timestamp: index + 3,
    })),
    { role: "assistant", content: [{ type: "text", text: "recent verified progress" }], timestamp: 15 },
    { role: "user", content: "Produce the cumulative checkpoint now.", timestamp: 16 },
  ];
  const before = structuredClone(parsed);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, turnToken, { experimentalMultipartParts: 6 });

  expect(() => assertMultipartFits(compiled, parsed)).not.toThrow();
  expect(compiled.multipart!.parts).toHaveLength(6);
  const trimmed = compiled.trimmedCompactionMessages!;
  expect(trimmed).toBeGreaterThan(1);
  expect(estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId)).toBeLessThan(ceiling(parsed));
  const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records);
  expect(records[0].content).toBe(parsed.context.systemPrompt![0]);
  const messages = records.filter(record => record.kind === "message").map(record => record.message);
  expect(messages[0].content).toBe(checkpoint);
  expect(messages.slice(1, -2).map(message => message.tool_call_id))
    .toEqual(parsed.context.messages.slice(trimmed + 1, -2).map(message =>
      message.role === "toolResult" ? message.toolCallId : undefined));
  expect(messages.at(-2).content).toEqual([{ type: "text", text: "recent verified progress" }]);
  expect(messages.at(-1).content).toBe("Produce the cumulative checkpoint now.");
  expect(compiled.multipart!.commit).toContain(`${trimmed} earlier history items were omitted`);
  expect(compiled.multipart!.commit).toContain("the supplied history is incomplete");
  expect(compiled.multipart!.commit).toContain("Preserve still-relevant progress, constraints and pending work");
  expect(compiled.multipart!.commit).not.toContain("The task context is complete.");
  // Independently put back the nearest omitted record: a non-minimal trim would still fit.
  const witness = compileChatGptWebPrompt({ ...parsed, _compactionRequest: false,
    context: { ...parsed.context, messages: [parsed.context.messages[1]!, ...parsed.context.messages.slice(trimmed)] } },
    capabilities, turnToken, { experimentalMultipartParts: 6 });
  witness.multipart!.commit = compiled.multipart!.commit;
  let witnessFailure: unknown;
  try { assertMultipartFits(witness, parsed); } catch (error) { witnessFailure = error; }
  expect(witnessFailure).toMatchObject({ code: "context_length_exceeded", retryable: false });
  expect(parsed).toEqual(before);
}, 30_000);

test.each([
  { family: "6", pro: true, effort: "xhigh", parts: 2, count: 12, words: 20_000 },
  { family: "6", pro: false, effort: "high", parts: 2, count: 7, words: 20_000 },
  { family: "6", pro: false, effort: "high", parts: 6, count: 7, words: 20_000 },
  { family: "5.6", pro: false, effort: "high", parts: 6, count: 14, words: 20_000 },
  { family: "5.6", pro: true, effort: "high", parts: 6, count: 17, words: 20_000 },
  { family: "6", pro: true, effort: "max", parts: 6, count: 17, words: 20_000 },
] as const)("compaction uses the browser's account, family, effort and part-count ceiling: %j", scenario => {
  const parsed = request();
  parsed._chatgptModelFamily = scenario.family;
  parsed.options.reasoning = scenario.effort;
  parsed.context.messages = [
    ...Array.from({ length: scenario.count }, (_, index) => ({
      // Keep character pressure independent of the total-token boundary under test.
      role: "user" as const, content: `history-${index} ${"x ".repeat(scenario.words)}`, timestamp: index + 1,
    })),
    { role: "user", content: "checkpoint now", timestamp: scenario.count + 1 },
  ];
  const caps = { ...capabilities, proAvailable: scenario.pro };
  const before = structuredClone(parsed);
  const normal = compileChatGptWebPrompt({ ...parsed, _compactionRequest: false }, caps, turnToken,
    { experimentalMultipartParts: scenario.parts });
  expect(estimateCompiledChatGptWebInputTokens(normal, parsed.modelId)).toBeGreaterThanOrEqual(ceiling(parsed, scenario.parts, caps));
  const compiled = compileChatGptWebPrompt(parsed, caps, turnToken, { experimentalMultipartParts: scenario.parts });
  expect(compiled.trimmedCompactionMessages).toBeGreaterThan(0);
  expect(estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId)).toBeLessThan(ceiling(parsed, scenario.parts, caps));
  expect(() => assertMultipartFits(compiled, parsed, caps)).not.toThrow();
  const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records);
  const contents = records.filter(record => record.kind === "message").map(record => record.message.content);
  expect(contents).toEqual(parsed.context.messages.slice(compiled.trimmedCompactionMessages).map(message => message.content));
  expect(compiled.multipart!.commit).toContain(`${compiled.trimmedCompactionMessages} earlier history items were omitted`);
  expect(parsed).toEqual(before);
}, 30_000);

test("Luna multipart compaction uses its experimental ceiling instead of its rolling context window", () => {
  const parsed = request();
  parsed.modelId = CHATGPT_WEB_LUNA_MODEL_ID;
  delete parsed._chatgptModelFamily;
  parsed.options.reasoning = "low";
  parsed.context.messages = [
    ...Array.from({ length: 11 }, (_, index) => ({
      role: "user" as const, content: `history-${index} ${"word ".repeat(8_000)}`, timestamp: index + 1,
    })),
    { role: "user", content: "checkpoint now", timestamp: 12 },
  ];
  const caps = { ...capabilities, solAvailable: false, extraHighAvailable: false, proAvailable: false };
  const compiled = compileChatGptWebPrompt(parsed, caps, turnToken, { experimentalMultipartParts: 6 });
  expect(compiled.trimmedCompactionMessages).toBeGreaterThan(0);
  expect(estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId)).toBeLessThan(ceiling(parsed, 6, caps));
  expect(() => assertMultipartFits(compiled, parsed, caps)).not.toThrow();
});

test("multipart compaction keeps history just below the ceiling without an extra percentage margin", () => {
  const parsed = request();
  parsed.context.messages = [
    ...Array.from({ length: 10 }, (_, index) => ({
      role: "user" as const, content: `history-${index} ${"word ".repeat(22_400)}`, timestamp: index + 1,
    })),
    { role: "user", content: "checkpoint now", timestamp: 11 },
  ];
  const before = structuredClone(parsed);
  const normal = compileChatGptWebPrompt({ ...parsed, _compactionRequest: false }, capabilities, turnToken,
    { experimentalMultipartParts: 6 });
  const normalTokens = estimateCompiledChatGptWebInputTokens(normal, parsed.modelId);
  expect(normalTokens).toBeLessThan(ceiling(parsed));
  expect(() => assertMultipartFits(normal, parsed)).not.toThrow();
  const compiled = compileChatGptWebPrompt(parsed, capabilities, turnToken, { experimentalMultipartParts: 6 });
  const tokens = estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId);
  expect(tokens).toBeGreaterThan(235_000);
  expect(tokens).toBeLessThan(240_000);
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(compiled.multipart!.commit).not.toContain("history is incomplete");
  expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records)
    .filter(record => record.kind === "message").map(record => record.message.content))
    .toEqual(parsed.context.messages.map(message => message.content));
  expect(() => assertMultipartFits(compiled, parsed)).not.toThrow();
  expect(parsed).toEqual(before);
});

test("multipart compaction budgets real transaction handles at the exclusive ceiling", () => {
  const parsed = request();
  parsed.context.messages = [
    ...Array.from({ length: 10 }, (_, index) => ({
      role: "user" as const, content: `history-${index} ${"word ".repeat(22_400)}`, timestamp: index,
    })),
    { role: "user", content: "checkpoint now", timestamp: 10 },
  ];
  const base = parsed.context.messages[9]!.content as string;
  const compile = () => compileChatGptWebPrompt(parsed, capabilities, turnToken,
    { experimentalMultipartParts: 6 });
  // Locate the actual compaction boundary, including its own terminal contract and wrappers.
  let lower = 0;
  let upper = 10_000;
  while (lower + 1 < upper) {
    const middle = Math.floor((lower + upper) / 2);
    parsed.context.messages[9]!.content = base + "x ".repeat(middle);
    if (compile().trimmedCompactionMessages === undefined) lower = middle;
    else upper = middle;
  }
  parsed.context.messages[9]!.content = base + "x ".repeat(lower);
  const before = structuredClone(parsed);
  const untrimmed = compile();
  const syntheticTokens = estimateCompiledChatGptWebInputTokens(untrimmed, parsed.modelId);
  expect(syntheticTokens).toBeLessThan(ceiling(parsed));
  expect(ceiling(parsed) - syntheticTokens).toBeLessThan(1_000);
  expect(untrimmed.trimmedCompactionMessages).toBeUndefined();
  expect(() => assertMultipartFits(untrimmed, parsed)).not.toThrow();
  expect(parsed).toEqual(before);
  parsed.context.messages[9]!.content = base + "x ".repeat(upper);
  expect(compile().trimmedCompactionMessages).toBeGreaterThan(0);
}, 30_000);

test("ordinary multipart turns retain all history and fail preflight above the ceiling", () => {
  const parsed = request();
  delete parsed._compactionRequest;
  parsed.context.messages = Array.from({ length: 12 }, (_, index) => ({
    role: "user", content: `history-${index} ${"word ".repeat(22_000)}`, timestamp: index + 1,
  }));
  const before = structuredClone(parsed);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, turnToken, { experimentalMultipartParts: 6 });
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records)
    .filter(record => record.kind === "message").map(record => record.message.content))
    .toEqual(parsed.context.messages.map(message => message.content));
  expect(estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId)).toBeGreaterThanOrEqual(ceiling(parsed));
  expect(() => assertMultipartFits(compiled, parsed)).toThrow(`${ceiling(parsed).toLocaleString("en-US")}-token six-part ceiling`);
  expect(parsed).toEqual(before);
});

test.each(([2, 6] as const).flatMap(parts =>
  (["checkpoint", "text parts checkpoint", "final instruction", "system"] as const).map(required => ({ parts, required }))))(
  "multipart compaction fails closed at the actual ceiling: %j", ({ parts, required }) => {
    const parsed = request();
    parsed.context.messages = [
      { role: "user", content: "discardable history", timestamp: 1 },
      { role: "user", content: "checkpoint now", timestamp: 3 },
    ];
    const oversized = "word ".repeat(ceiling(parsed, parts));
    if (required === "checkpoint" || required === "text parts checkpoint") {
      parsed.context.messages.splice(1, 0, {
        role: "user", content: required === "checkpoint" ? `${SUMMARY_PREFIX}\n${oversized}`
          : [{ type: "text", text: SUMMARY_PREFIX }, { type: "text", text: oversized }], timestamp: 2,
      });
    } else if (required === "final instruction") {
      parsed.context.messages.at(-1)!.content = oversized;
    } else {
      parsed.context.systemPrompt = Array.from({ length: 4 }, () => "word ".repeat(Math.ceil(ceiling(parsed, parts) / 4)));
    }
    const before = structuredClone(parsed);
    let error: unknown;
    try {
      compileChatGptWebPrompt(parsed, capabilities, turnToken, { experimentalMultipartParts: parts });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "context_length_exceeded", retryable: false, status: 400 });
    expect((error as Error).message).toContain("after other history was trimmed");
    expect((error as Error).message).toContain(`${ceiling(parsed, parts).toLocaleString("en-US")}-token ${parts === 2 ? "two-part" : "six-part"} ceiling`);
    expect((error as Error).message).toContain("required system context");
    if (required.includes("checkpoint")) expect((error as Error).message).toContain("cumulative checkpoint");
    expect((error as Error).message).not.toContain("Run /compact");
    expect(parsed).toEqual(before);
  }, 30_000,
);

test("multipart compaction drops a discardable oversized atomic record without splitting it", () => {
  const parsed = request();
  parsed.context.messages = [
    { role: "user", content: "word ".repeat(110_000), timestamp: 1 },
    { role: "user", content: "checkpoint now", timestamp: 2 },
  ];
  const before = structuredClone(parsed);
  const normal = compileChatGptWebPrompt({ ...parsed, _compactionRequest: false }, capabilities, turnToken,
    { experimentalMultipartParts: 6 });
  expect(normal.trimmedCompactionMessages).toBeUndefined();
  expect(() => assertMultipartFits(normal, parsed)).toThrow("No ChatGPT effort available");
  const compiled = compileChatGptWebPrompt(parsed, capabilities, turnToken, { experimentalMultipartParts: 6 });
  expect(estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId)).toBeLessThan(ceiling(parsed));
  expect(compiled.trimmedCompactionMessages).toBe(1);
  expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records)
    .filter(record => record.kind === "message").map(record => record.message.content))
    .toEqual(["checkpoint now"]);
  expect(() => assertMultipartFits(compiled, parsed)).not.toThrow();
  expect(parsed).toEqual(before);
});

test.each(["checkpoint", "final instruction", "system"] as const)(
  "multipart compaction rejects an irreducible physical message (%s)", required => {
    const parsed = request();
    const oversized = "word ".repeat(110_000);
    parsed.context.messages = [{ role: "user", content: "discardable history", timestamp: 1 },
      { role: "user", content: "checkpoint now", timestamp: 3 }];
    if (required === "checkpoint") parsed.context.messages.splice(1, 0,
      { role: "user", content: `${SUMMARY_PREFIX}\n${oversized}`, timestamp: 2 });
    else if (required === "system") parsed.context.systemPrompt = [oversized];
    else parsed.context.messages.at(-1)!.content = oversized;
    const before = structuredClone(parsed);
    let error: unknown;
    try { compileChatGptWebPrompt(parsed, capabilities, turnToken, { experimentalMultipartParts: 6 }); }
    catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "context_length_exceeded", retryable: false, status: 400 });
    expect((error as Error).message).toContain("after other history was trimmed");
    expect((error as Error).message).not.toContain("Run /compact");
    expect(parsed).toEqual(before);
  },
);

test("multipart compaction recovers when an old skill exhausts the final attachment budget", () => {
  const parsed = request();
  parsed.context.messages = [
    { role: "user", origin: "codex_skill", content: `<skill><name>old</name>${"word ".repeat(110_000)}</skill>`, timestamp: 1 },
    { role: "user", content: "checkpoint now", timestamp: 2 },
  ];
  const before = structuredClone(parsed);
  let failure: unknown;
  let compiled: CompiledChatGptWebPrompt | undefined;
  try { compiled = compileChatGptWebPrompt(parsed, capabilities, turnToken,
    { experimentalMultipartParts: 6, experimentalSkillAttachments: true }); }
  catch (error) { failure = error; }
  expect(failure).toBeUndefined();
  expect(compiled!.trimmedCompactionMessages).toBe(1);
  expect(compiled!.skillFiles ?? []).toHaveLength(0);
  expect(() => assertMultipartFits(compiled!, parsed)).not.toThrow();
  expect(parsed).toEqual(before);
});

test("multipart compaction counts and rebuilds image and skill attachments after trimming", () => {
  const parsed = request();
  parsed.context.messages = [
    { role: "user", content: [{ type: "image", imageUrl: "data:image/png;base64,old-image", detail: "original" }], timestamp: 1 },
    { role: "user", origin: "codex_skill", content: `<skill><name>old-skill</name>${"word ".repeat(8_000)}</skill>`, timestamp: 2 },
    ...Array.from({ length: 10 }, (_, index) => ({
      role: "user" as const, content: `history-${index} ${"word ".repeat(22_000)}`, timestamp: index + 3,
    })),
    { role: "user", content: [{ type: "image", imageUrl: "data:image/png;base64,new-image", detail: "original" }], timestamp: 13 },
    { role: "user", origin: "codex_skill", content: `<skill><name>new-skill</name>${"word ".repeat(3_000)}</skill>`, timestamp: 14 },
    { role: "user", content: "checkpoint now", timestamp: 15 },
  ];
  const before = structuredClone(parsed);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, turnToken, {
    experimentalMultipartParts: 6, experimentalSkillAttachments: true, includeContextTokenBreakdown: true,
  });
  expect(compiled.trimmedCompactionMessages).toBeGreaterThanOrEqual(3);
  expect(estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId)).toBeLessThan(ceiling(parsed));
  expect(compiled.images).toEqual([{ ref: "codex-input-image-1", imageUrl: "data:image/png;base64,new-image", detail: "original" }]);
  expect(compiled.skillFiles).toHaveLength(1);
  expect(compiled.skillFiles![0]!.text).toBe(parsed.context.messages.at(-2)!.content as string);
  const attachmentTokens = estimateChatGptWebImageTokens(compiled) + skillFileTokens(compiled.skillFiles, parsed.modelId);
  expect(attachmentTokens).toBeGreaterThan(0);
  expect(estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId)
    - estimateCompiledChatGptWebInputTokens({ ...compiled, images: [], skillFiles: [] }, parsed.modelId)).toBe(attachmentTokens);
  const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records);
  const messages = records.filter(record => record.kind === "message").map(record => record.message);
  expect(messages).toHaveLength(parsed.context.messages.length - compiled.trimmedCompactionMessages!);
  expect(messages.slice(0, -3).map(message => message.content))
    .toEqual(parsed.context.messages.slice(compiled.trimmedCompactionMessages, -3).map(message => message.content));
  expect(messages.at(-3).content).toEqual([{ type: "image_attachment", attachment_ref: "codex-input-image-1", detail: "original" }]);
  expect(messages.at(-2).content).toEqual([{ type: "skill_attachment", filename: compiled.skillFiles![0]!.name }]);
  expect(messages.at(-1).content).toBe("checkpoint now");
  expect(compiled.contextTokenBreakdown!.user!.records).toBe(messages.length);
  expect(() => assertMultipartFits(compiled, parsed)).not.toThrow();
  expect(parsed).toEqual(before);
}, 30_000);

test.each([undefined, 6] as const)("trimmed compaction retains one native terminal control contract (parts=%s)", parts => {
  const parsed = request();
  parsed.context.messages = [
    ...Array.from({ length: 12 }, (_, index) => ({
      role: "user" as const, content: `history-${index} ${"word ".repeat(22_000)}`, timestamp: index,
    })),
    { role: "user", content: "checkpoint now", timestamp: 12 },
  ];
  const before = structuredClone(parsed);
  const control = "Submit the summary through codex.control.compaction_handoff exactly once.";
  const compiled = compileChatGptWebPrompt(parsed, capabilities, turnToken, {
    experimentalMultipartParts: parts, nativeControlConnector: true, compactionControlInstruction: control,
  });
  expect(compiled.trimmedCompactionMessages).toBeGreaterThan(0);
  expect(compiled.text.split(control)).toHaveLength(2);
  expect(compiled.text).toContain("Submit the checkpoint through the one-shot control operation now; do not write it as ordinary assistant text.");
  expect(compiled.text).toContain("Complete this response only through the one-shot compaction handoff control.");
  expect(compiled.text).not.toContain("Produce the requested checkpoint summary now without calling tools.");
  expect(compiled.text).not.toContain("Return only the answer that the outer Codex task should receive.");
  expect(compiled.text).toContain("the supplied history is incomplete");
  if (parts) expect(() => assertMultipartFits(compiled, parsed)).not.toThrow();
  expect(parsed).toEqual(before);
}, 30_000);
