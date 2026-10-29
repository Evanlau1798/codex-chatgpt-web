import { expect, test } from "bun:test";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { prepareChatGptWebMultipartTransport } from "../src/adapters/chatgpt-web/multipart-browser-transport";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import type { CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: false, solAvailable: true, proAvailable: true };
function request(): CodexParsedRequest {
  return { modelId: CHATGPT_WEB_MODEL_ID, _chatgptModelFamily: "6", _compactionRequest: true,
    options: { reasoning: "high" }, stream: false, context: { systemPrompt: ["Preserve all supplied evidence."], messages: [
      { role: "assistant", content: [{ type: "text", text: "obsolete-before-checkpoint" }], timestamp: 0 },
      { role: "user", content: `${SUMMARY_PREFIX}\nCUMULATIVE_CHECKPOINT: preserve decisions and completed work.`, timestamp: 1 },
      ...Array.from({ length: 8 }, (_, index) => ({ role: "assistant" as const,
        content: [{ type: "text" as const, text: `history-${index}:` + " observed detail".repeat(20_000) }], timestamp: index + 2 })),
      { role: "user", content: "FINAL_COMPACT_INSTRUCTION: summarize remaining work without inventing missing evidence.", timestamp: 10 },
    ] } };
}
const compile = (parsed: CodexParsedRequest) => compileChatGptWebPrompt(parsed, capabilities, undefined,
  { experimentalMultipartParts: 6 });

test("#930 lost retained chat compacts an oversized six-part history within real browser limits", () => {
  const parsed = request();
  const before = structuredClone(parsed.context.messages);
  const normal = compile({ ...parsed, _compactionRequest: false });
  expect(estimateCompiledChatGptWebInputTokens(normal, parsed.modelId)).toBeGreaterThan(240_000);
  expect(() => { prepareChatGptWebMultipartTransport(normal, parsed.modelId, capabilities, "high", "6"); })
    .toThrow("ceiling");
  const compact = compile(parsed);
  expect(compact.trimmedCompactionMessages).toBeGreaterThan(0);
  expect(() => { prepareChatGptWebMultipartTransport(compact, parsed.modelId, capabilities, "high", "6"); })
    .not.toThrow();
  const messages = compact.multipart!.parts.flatMap(part => JSON.parse(part).records)
    .filter((record: any) => record.kind === "message").map((record: any) => record.message);
  expect(JSON.stringify(messages)).toContain("CUMULATIVE_CHECKPOINT");
  expect(JSON.stringify(messages.at(-1))).toContain("FINAL_COMPACT_INSTRUCTION");
  expect(compact.multipart!.commit).toContain("earlier history items were omitted");
  expect(compact.multipart!.commit).toContain("the supplied history is incomplete");
  expect(compact.multipart!.commit).toContain("Do not infer that omitted work was never done");
  expect(parsed.context.messages).toEqual(before);
  expect(normal.trimmedCompactionMessages).toBeUndefined();
  const retained = JSON.stringify(normal.multipart!.parts.map(part => JSON.parse(part)));
  for (let index = 0; index < 8; index++) expect(retained.includes(`history-${index}:`)).toBeTrue();
}, 30_000);

test("#930 an irreducible checkpoint fails explicitly instead of telling a compaction to compact again", () => {
  const parsed = request();
  parsed.context.messages = [
    { role: "user", content: `${SUMMARY_PREFIX}\n` + " mandatory checkpoint".repeat(140_000), timestamp: 1 },
    parsed.context.messages.at(-1)!,
  ];
  expect(() => { compile(parsed); }).toThrow("cumulative checkpoint and final compaction instruction");
}, 30_000);
