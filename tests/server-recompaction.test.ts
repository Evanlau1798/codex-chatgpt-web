import { expect, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import { defaultConfig } from "../src/config";
import { COMPACT_PROMPT, SUMMARY_PREFIX, decodeCompactionSummary } from "../src/responses/compaction";
import { compactRequest, responseRequest } from "../src/server";
import type { CodexProviderConfig } from "../src/types";

const model = "chatgpt-web/high";
const summary = "The repository was inspected. Continue by implementing the bounded Web context contract.";

function compactionAdapterFactory(
  seenProviders: CodexProviderConfig[] = [],
  expectedPreviousSummary?: string,
) {
  return (provider: CodexProviderConfig): ProviderAdapter => {
    seenProviders.push(structuredClone(provider));
    return {
      name: "test-web-compactor",
      async runTurn(parsed, _incoming, emit) {
        expect(parsed._compactionRequest).toBe(true);
        expect(parsed.context.tools).toBeUndefined();
        expect(parsed.options.toolChoice).toBeUndefined();
        expect(parsed.options.parallelToolCalls).toBeUndefined();
        if (expectedPreviousSummary) {
          expect(parsed.context.messages).toContainEqual(expect.objectContaining({
            role: "user",
            content: expectedPreviousSummary,
          }));
        }
        expect(parsed.context.messages.at(-1)).toMatchObject({ role: "user", content: COMPACT_PROMPT });
        emit({ type: "text_delta", text: summary, phase: "final_answer" });
        emit({
          type: "done",
          stopReason: "stop",
          endTurn: true,
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, estimated: true },
        });
      },
    };
  };
}

test("compacts ChatGPT Web v1 through a dedicated read-only browser summarization turn", async () => {
  const providers: CodexProviderConfig[] = [];
  const previousSummary = `${SUMMARY_PREFIX}\nPrevious cumulative checkpoint`;
  const config = defaultConfig("full");
  const response = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "First request" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "First answer" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: previousSummary }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Latest request" }] },
      ],
    }),
  }), config, compactionAdapterFactory(providers, previousSummary));

  expect(response.status).toBe(200);
  expect(providers).toHaveLength(1);
  expect(providers[0]!.chatgptWeb?.localToolsEnabled).toBe(true);
  const body = await response.json() as { output: Array<{ role: string; content: Array<{ text: string }> }> };
  expect(body.output.map(item => item.content[0]!.text)).toEqual([
    "First request",
    "Latest request",
    `${SUMMARY_PREFIX}\n${summary}`,
  ]);
});

test("v2 recompaction reads the previous checkpoint once and replaces it with one new compaction item", async () => {
  const config = defaultConfig("full");
  const firstResponse = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "First request" }] },
        { type: "compaction_trigger" },
      ],
    }),
  }), config, compactionAdapterFactory());
  expect(firstResponse.status).toBe(200);
  const firstBody = await firstResponse.json() as {
    output: Array<{ type: string; encrypted_content?: string }>;
  };
  expect(firstBody.output).toHaveLength(1);
  const previousCompaction = firstBody.output[0]!;

  const updatedSummary = "The previous checkpoint was consumed. Continue with the latest request only.";
  const secondResponse = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      input: [
        previousCompaction,
        { type: "message", role: "user", content: [{ type: "input_text", text: "Latest request" }] },
        { type: "compaction_trigger" },
      ],
    }),
  }), config, () => ({
    name: "v2-recompaction-check",
    async runTurn(parsed, _incoming, emit) {
      const previousSummaryText = `${SUMMARY_PREFIX}\n\n${summary}`;
      expect(parsed.context.messages.filter(message => (
        message.role === "user" && message.content === previousSummaryText
      ))).toHaveLength(1);
      expect(parsed.context.messages).toContainEqual(expect.objectContaining({
        role: "user",
        content: "Latest request",
      }));
      expect(parsed.context.messages.at(-1)).toMatchObject({ role: "user", content: COMPACT_PROMPT });
      emit({ type: "text_delta", text: updatedSummary, phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));

  expect(secondResponse.status).toBe(200);
  const secondBody = await secondResponse.json() as {
    status: string;
    output: Array<{ type: string; encrypted_content?: string }>;
  };
  expect(secondBody.status).toBe("completed");
  expect(secondBody.output).toHaveLength(1);
  expect(secondBody.output[0]!.type).toBe("compaction");
  expect(decodeCompactionSummary(secondBody.output[0]!.encrypted_content ?? ""))
    .toBe(updatedSummary);
});
