import { expect, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import { defaultConfig } from "../src/config";
import { COMPACT_PROMPT, encodeCompactionSummary } from "../src/responses/compaction";
import { compactRequest, responseRequest } from "../src/server";
import type { CodexProviderConfig } from "../src/types";
import { extractChatGptTurnIdentity, extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";

const model = "chatgpt-web/high";
const summary = "The repository was inspected. Continue by implementing the bounded Web context contract.";

function compactionAdapterFactory(
  seenProviders: CodexProviderConfig[] = [],
  emittedSummary = summary,
  stopReason = "stop",
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
        expect(parsed.context.messages.at(-1)).toMatchObject({ role: "user", content: COMPACT_PROMPT });
        emit({ type: "text_delta", text: emittedSummary, phase: "final_answer" });
        emit({
          type: "done",
          stopReason,
          endTurn: true,
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, estimated: true },
        });
      },
    };
  };
}

for (const format of ["v1", "v2"] as const) test(`${format} pre-turn compaction authorizes only its exact native continuation`, async () => {
  const config = defaultConfig("full");
  const metadata = { thread_id: `thread_preturn_${format}`, turn_id: `turn_preturn_${format}` };
  const source = {
    type: "message", role: "user", id: "msg_original", content: [{ type: "input_text", text: "Continue the original task" }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn_before_preturn_compaction" },
  };
  const original = {
    model, stream: false, input: [source],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
  };
  const compact = format === "v1"
    ? await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
      method: "POST", body: JSON.stringify(original),
    }), config, compactionAdapterFactory())
    : await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify({ ...original, input: [source, { type: "compaction_trigger" }] }),
    }), config, compactionAdapterFactory());
  expect(compact.status).toBe(200);
  const compacted = await compact.json() as { output: unknown[] };
  const input = format === "v1" ? compacted.output : [source, ...compacted.output];
  const continuation = { ...original, input };
  let starts = 0;
  const factory = (): ProviderAdapter => ({
    name: "native-post-compaction-continuation",
    async runTurn(parsed, _incoming, emit) {
      starts += 1;
      expect(extractChatGptTurnIdentity(parsed).turnId).toBe(metadata.turn_id);
      expect(extractChatGptTurnUserRevision(parsed)).toEqual(source.content);
      emit({ type: "text_delta", text: "Continued after compaction", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  });
  const send = (body: unknown) => responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify(body),
  }), config, factory);
  const resumed = await send(continuation);
  expect(resumed.status).toBe(200);
  expect((await resumed.json() as { status: string }).status).toBe("completed");
  expect(starts).toBe(1);
  const toolRound = await send({ ...continuation, input: [...input,
    { type: "function_call", call_id: "call_native_round", name: "exec_command", arguments: "{}" },
    { type: "function_call_output", call_id: "call_native_round", output: "Native tool result" },
  ] });
  expect(toolRound.status).toBe(200);
  expect((await toolRound.json() as { status: string }).status).toBe("completed");
  // A checkpoint's text alone is not authority to start another task, another native turn,
  // a different model, or a rewritten source instruction.
  for (const changed of [
    { ...continuation, client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata, thread_id: "another_thread" }) } },
    { ...continuation, client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata, turn_id: "another_turn" }) } },
    { ...continuation, model: "chatgpt-web/medium" },
    { ...continuation, input: input.map(item => (item as { id?: string }).id === source.id
      ? { ...source, content: [{ type: "input_text", text: "Different task" }] } : item) },
    { ...continuation, input: [source, { type: "compaction", encrypted_content: encodeCompactionSummary("Unrecognized checkpoint") }] },
    { ...continuation, input: [...input, { type: "message", role: "user",
      content: [{ type: "input_text", text: "<turn_aborted>The user interrupted this turn.</turn_aborted>" }],
      internal_chat_message_metadata_passthrough: source.internal_chat_message_metadata_passthrough,
    }] },
  ]) {
    expect((await send(changed)).status).toBe(400);
  }
  expect(starts).toBe(2);
});

test("completed streamed checkpoint authorizes continuation but a rejected V1 budget does not", async () => {
  const config = defaultConfig("full");
  for (const budgetFailure of [false, true]) {
    const checkpoint = budgetFailure ? "checkpoint ".repeat(85_000) : summary;
    const source = { type: "message", role: "user", content: "Continue the inspected task.",
      internal_chat_message_metadata_passthrough: { turn_id: "source-budget-stream" } };
    const original = { model, input: [source], client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: `budget-stream-${budgetFailure}`, turn_id: "checkpoint-turn" }),
    } };
    const request = (body: unknown) => new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify(body) });
    const compact = budgetFailure
      ? await compactRequest(request(original), config, compactionAdapterFactory([], checkpoint))
      : await responseRequest(request({ ...original, stream: true, input: [source, { type: "compaction_trigger" }] }),
        config, compactionAdapterFactory());
    if (budgetFailure) {
      expect(compact.status).toBe(400);
      expect(await compact.json()).toMatchObject({ error: { code: "compaction_budget_exceeded" } });
    } else {
      const stream = await compact.text();
      expect(stream.match(/event: response.completed/g)).toHaveLength(1);
      expect(stream).toContain('"status":"completed"');
    }
    let starts = 0;
    const resumed = await responseRequest(request({ ...original, stream: false,
      input: [source, { type: "compaction", encrypted_content: encodeCompactionSummary(checkpoint) }],
    }), config, () => ({ name: "stream-checkpoint-resume", async runTurn(_parsed, _incoming, emit) {
      starts++;
      emit({ type: "text_delta", text: "Resumed", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    } }));
    expect(starts).toBe(budgetFailure ? 0 : 1);
    expect(resumed.status).toBe(budgetFailure ? 400 : 200);
    if (!budgetFailure) expect(await resumed.json()).toMatchObject({ status: "completed" });
  }
});

test("v1 post-compaction continuation retains the producer's bounded source representation", async () => {
  const config = defaultConfig("full");
  const source = { type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(80_100) }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn_long_source" } };
  const original = { model, stream: false, input: [source], client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_long_source", turn_id: "turn_after_long_source" }),
  } };
  const compact = await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
    method: "POST", body: JSON.stringify(original),
  }), config, compactionAdapterFactory());
  expect(compact.status).toBe(200);
  const compacted = await compact.json() as { output: unknown[] };
  let receivedRevision: unknown;
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify({ ...original, input: compacted.output }),
  }), config, () => ({ name: "bounded-continuation", async runTurn(parsed, _incoming, emit) {
    receivedRevision = extractChatGptTurnUserRevision(parsed);
    emit({ type: "text_delta", text: "Done", phase: "final_answer" });
    emit({ type: "done", stopReason: "stop", endTurn: true });
  } }));
  expect(response.status).toBe(200);
  const completed = await response.json() as { status: string; output: unknown[] };
  expect(completed.status).toBe("completed");
  expect(JSON.stringify(completed.output)).toContain('"text":"Done"');
  expect(receivedRevision).toEqual(source.content);
});

for (const stream of [false, true]) test(`failed compaction cannot authorize a continuation (stream=${stream})`, async () => {
  const config = defaultConfig("full");
  const source = { type: "message", role: "user", content: [{ type: "input_text", text: "Original task" }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn_failed_source" } };
  const original = { model, stream, input: [source], client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({ thread_id: `thread_failed_checkpoint_${stream}`, turn_id: "turn_failed_checkpoint" }),
  } };
  const failed = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify({ ...original, input: [source, { type: "compaction_trigger" }] }),
  }), config, () => ({ name: "failed-checkpoint", async runTurn(_parsed, _incoming, emit) {
    emit({ type: "text_delta", text: summary, phase: "final_answer" });
    emit({ type: "error", message: "Compaction failed before completion" });
  } }));
  // Consume the stream as native Codex does; only an actual completed checkpoint is evidence.
  expect(await failed.text()).toContain("Compaction failed before completion");
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify({ ...original, stream: false,
      input: [source, { type: "compaction", encrypted_content: encodeCompactionSummary(summary) }],
    }),
  }), config, () => { throw new Error("Failed checkpoint must not authorize a new browser execution"); });
  expect(response.status).toBe(400);
});
