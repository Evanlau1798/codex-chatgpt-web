import { expect, test } from "bun:test";
import { defaultConfig, type AppConfig } from "../src/config";
import { responseRequest } from "../src/server";
import type { CodexParsedRequest, CodexProviderConfig } from "../src/types";

// Producer fields captured from the installed Codex app-server's prediction fork.
const metadata = {
  request_kind: "turn", thread_source: "composer_predictions", turn_trigger: "composer_predictions",
  thread_id: "prediction-thread", turn_id: "prediction-turn", forked_from_thread_id: "parent-thread",
};
const prompt = "Suggest the next user message. Return only JSON with a suggestion string or null.";
const base = {
  model: "chatgpt-web/gpt-6-pro", reasoning: { effort: "max" }, stream: false,
  client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
  text: { format: { type: "json_schema", name: "suggestion", strict: true,
    schema: { type: "object", properties: { suggestion: { type: ["string", "null"] } }, required: ["suggestion"], additionalProperties: false } } },
};

async function send(body: unknown, config: AppConfig = { ...defaultConfig("full"), proAvailable: true }) {
  let observed: { parsed: CodexParsedRequest; provider: CodexProviderConfig } | undefined;
  let constructions = 0;
  const response = await responseRequest(new Request("http://localhost/v1/responses", {
    method: "POST", body: JSON.stringify(body),
  }), config, provider => {
    constructions++;
    return { name: "prediction-test", async runTurn(parsed, _request, emit) {
      observed = { parsed, provider };
      emit({ type: "text_delta", text: '{"suggestion":"Show me the diff."}', phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    } };
  }, { rememberState: false });
  const text = await response.text();
  return { response, text, observed, constructions };
}

test("prediction policy uses Sol 6 Medium, keeps history/schema, and never exposes tools or alters saved preferences", async () => {
  const config = { ...defaultConfig("full"), proAvailable: true, experimentalBiggerContext: true,
    experimentalSkillAttachments: true, useSavedChats: true };
  const before = structuredClone(config);
  for (const model of ["chatgpt-web/gpt-6-pro", "chatgpt-web/gpt-5.6-sol"]) {
    const body = { ...base, model, tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
      input: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "The requested patch is ready." }] }, ...base.input] };
    const { response, text, observed } = await send(body, config);
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ model: "chatgpt-web/gpt-6-sol", status: "completed" });
    expect(observed!.parsed).toMatchObject({ modelId: "gpt-5.6-sol", _chatgptModelFamily: "6",
      options: { reasoning: "medium", outputFormat: { schema: base.text.format.schema } } });
    expect(observed!.parsed.context.messages).toHaveLength(2);
    expect(observed!.parsed.context.tools).toBeUndefined();
    expect(observed!.provider.chatgptWeb).toMatchObject({ localToolsEnabled: false, experimentalBiggerContext: false,
      experimentalSkillAttachments: false, experimentalFreshConversationPerTurn: true, useSavedChats: false });
    expect(config).toEqual(before);
  }
});

test("the prediction response also reaches Codex through the normal SSE completion", async () => {
  const { response, text } = await send({ ...base, stream: true });
  expect(response.status).toBe(200);
  const completed = text.split("\n").find(line => line.startsWith('data: {"type":"response.completed"'))!;
  const result = JSON.parse(completed.slice(6)).response;
  expect(result.model).toBe("chatgpt-web/gpt-6-sol");
  expect(JSON.parse(result.output[0].content[0].text)).toEqual({ suggestion: "Show me the diff." });
});

test("disabled, Free, and manual-mode predictions stop before constructing an adapter", async () => {
  for (const change of [{ composerPredictionsEnabled: false }, { solAvailable: false, proAvailable: false },
    { browserInteractionMode: "manual" as const }]) {
    const result = await send(base, { ...defaultConfig("full"), ...change });
    expect(result.response.status).toBe(400);
    expect(result.constructions).toBe(0);
    expect(JSON.parse(result.text).error.type).toBe("invalid_request_error");
  }
});

test("oversized predictions skip rather than opening a tab, staging, or silently shortening history", async () => {
  for (const proAvailable of [false, true]) {
    const result = await send({ ...base, input: [{ type: "message", role: "user", content: [{
      type: "input_text", text: "preserve this entire history ".repeat(60_000),
    }] }] }, { ...defaultConfig("full"), proAvailable, experimentalBiggerContext: true });
    expect(result.response.status).toBe(400);
    expect(result.constructions).toBe(0);
    expect(result.text).toContain("Next-message prediction skipped");
  }
});

test("excess image context skips predictions rather than omitting images", async () => {
  const result = await send({ ...base, input: [{ type: "message", role: "user", content: [
    { type: "input_text", text: prompt },
    ...Array.from({ length: 11 }, (_, i) => ({ type: "input_image", image_url: `https://example.com/${i}.png` })),
  ] }] });
  expect(result.response.status).toBe(400);
  expect(result.constructions).toBe(0);
  expect(result.text).toContain("more images");
});

test("prompt wording and inherited thread source do not reclassify real user turns", async () => {
  for (const client_metadata of [undefined, { "x-codex-turn-metadata": "not-json" },
    { "x-codex-turn-metadata": JSON.stringify({ ...metadata, turn_trigger: "user" }) }]) {
    const { response, observed } = await send({ ...base, client_metadata });
    expect(response.status).toBe(200);
    expect(observed!.parsed).toMatchObject({ _chatgptModelFamily: "6", options: { reasoning: "max" } });
    expect(observed!.provider.chatgptWeb!.localToolsEnabled).toBe(true);
  }
});

test("missing continuation state cannot produce a prediction from incomplete context", async () => {
  const result = await send({ ...base, previous_response_id: "missing-prediction-parent" });
  expect(result.response.status).toBe(409);
  expect(result.constructions).toBe(0);
});
