import { expect, test } from "bun:test";
import { defaultBrokerEndpoint, defaultConfig, type AppConfig } from "../src/config";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatGptRuntimeStarter } from "../src/adapters/chatgpt-web/adapter-runtime-factory";
import { TurnBroker, RemoteTurnBroker, callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { submitNativeOutputControl } from "../src/adapters/chatgpt-web/native-output-control";
import { ChatGptLunaCheckpointStore } from "../src/adapters/chatgpt-web/rolling-checkpoint";
import { EnhancedRecoveryCheckpointStore } from "../src/adapters/chatgpt-web/enhanced-recovery-checkpoint";
import { runChatGptTunneledOutputTurn } from "../src/adapters/chatgpt-web/tunneled-output-turn";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { responseRequest } from "../src/server";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";
import { cachedComposerPrediction, COMPOSER_PREDICTION_TTL_MS, rememberComposerPrediction } from "../src/composer-predictions";
import { parseRequest } from "../src/responses/parser";

function suggestion(text: string): unknown {
  const response = text.startsWith("event:") ? JSON.parse(text.split("\n")
    .find(line => line.startsWith("data:") && line.includes('"type":"response.completed"'))!.slice(6)).response : JSON.parse(text);
  return JSON.parse(response.output[0].content[0].text).suggestion;
}

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

test("disabled predictions and opt-in cache misses return null before adapter creation", async () => {
  for (const account of [{ solAvailable: false, proAvailable: false },
    { solAvailable: true, proAvailable: false }, { solAvailable: true, proAvailable: true }]) {
    for (const composerPredictionsEnabled of [false, true]) {
      const config = { ...defaultConfig("full"), ...account, composerPredictionsEnabled };
      const before = structuredClone(config);
      for (const stream of [false, true]) {
        const result = await send({ ...base, stream }, config);
        expect(result.response.status).toBe(200);
        expect(result.constructions).toBe(0);
        expect(suggestion(result.text)).toBeNull();
      }
      expect(config).toEqual(before);
    }
  }
});

test("prediction cache misses cannot forward history, tools or output schemas to a Web turn", async () => {
  const config = { ...defaultConfig("full"), proAvailable: true, experimentalBiggerContext: true,
    experimentalSkillAttachments: true, useSavedChats: true };
  const before = structuredClone(config);
  for (const model of ["chatgpt-web/gpt-6-pro", "chatgpt-web/gpt-5.6-sol"]) {
    const body = { ...base, model, tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
      input: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "The requested patch is ready." }] }, ...base.input] };
    const { response, text, observed } = await send(body, config);
    expect(response.status).toBe(200);
    expect(suggestion(text)).toBeNull();
    expect(observed).toBeUndefined();
    expect(config).toEqual(before);
  }
});

test("streaming predictions receive a completed local SSE response", async () => {
  const { response, text } = await send({ ...base, stream: true });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(text).toContain("response.completed");
  expect(suggestion(text)).toBeNull();
});

test("disabled, Free, and manual-mode predictions stop before constructing an adapter", async () => {
  for (const change of [{ composerPredictionsEnabled: false }, { solAvailable: false, proAvailable: false },
    { browserInteractionMode: "manual" as const }]) {
    const result = await send(base, { ...defaultConfig("full"), ...change });
    expect(result.response.status).toBe(200);
    expect(result.constructions).toBe(0);
    expect(suggestion(result.text)).toBeNull();
  }
});

test("oversized predictions skip rather than opening a tab, staging, or silently shortening history", async () => {
  for (const proAvailable of [false, true]) {
    const result = await send({ ...base, input: [{ type: "message", role: "user", content: [{
      type: "input_text", text: "preserve this entire history ".repeat(60_000),
    }] }] }, { ...defaultConfig("full"), proAvailable, experimentalBiggerContext: true });
    expect(result.response.status).toBe(200);
    expect(result.constructions).toBe(0);
    expect(suggestion(result.text)).toBeNull();
  }
});

test("excess image context skips predictions rather than omitting images", async () => {
  const result = await send({ ...base, input: [{ type: "message", role: "user", content: [
    { type: "input_text", text: prompt },
    ...Array.from({ length: 11 }, (_, i) => ({ type: "input_image", image_url: `https://example.com/${i}.png` })),
  ] }] });
  expect(result.response.status).toBe(200);
  expect(result.constructions).toBe(0);
  expect(suggestion(result.text)).toBeNull();
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
  expect(result.response.status).toBe(200);
  expect(result.constructions).toBe(0);
  expect(suggestion(result.text)).toBeNull();
});

test("a completed parent publishes its same-final suggestion without exposing it in the parent answer", async () => {
  const config = { ...defaultConfig("full"), composerPredictionsEnabled: true };
  const parent = { model: "chatgpt-web/gpt-6-sol", stream: false,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: "parent-thread", turn_id: "parent-turn" }) },
    input: [{ role: "user", content: "Review this change." }] };
  const response = await responseRequest(new Request("http://localhost/v1/responses", {
    method: "POST", body: JSON.stringify(parent),
  }), config, () => ({ name: "same-final-test", async runTurn(parsed, _request, emit) {
    Object.assign(parsed, { _composerPrediction: { enabled: true, suggestion: "Show the diff." } });
    emit({ type: "text_delta", text: "Review complete.", phase: "final_answer" });
    emit({ type: "done", stopReason: "stop", endTurn: true });
  } }), { rememberState: false });
  const parentText = await response.text();
  expect(parentText).not.toContain("Show the diff.");
  const result = await send({ ...base, model: parent.model, input: [...parent.input,
    { role: "assistant", content: "Review complete." }, ...base.input] }, config);
  expect(result.response.status).toBe(200);
  expect(result.constructions).toBe(0);
  expect(result.text).toContain('Show the diff.');
  for (const change of [{ composerPredictionsEnabled: false }, { useEnhancedWebSessionMode: false },
    { useEnhancedOutputTunnel: false }, { browserInteractionMode: "manual" as const }]) {
    const miss = await send({ ...base, model: parent.model, input: [...parent.input,
      { role: "assistant", content: "Review complete." }, ...base.input] }, { ...config, ...change });
    expect(miss.constructions).toBe(0);
    expect(suggestion(miss.text)).toBeNull();
  }
});

test("prediction cache binds namespace, parent owner, exact user content and final answer with absolute TTL", () => {
  const body = { model: "chatgpt-web/gpt-6-sol", input: [{ role: "user", content: "Exact user content." }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "cache-parent" }) } };
  const parsed = parseRequest(body);
  parsed._composerPrediction = { enabled: true, suggestion: "Next step?" };
  const output = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Complete final." }] }];
  const request = { ...body, input: [...body.input, { role: "assistant", content: "Complete final." }, ...base.input],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata, forked_from_thread_id: "cache-parent" }) } };
  rememberComposerPrediction(parsed, { status: "failed", output }, "cache-profile", 100);
  expect(cachedComposerPrediction(request, "cache-profile", 101)).toBeNull();
  rememberComposerPrediction(parsed, { status: "completed", output }, "cache-profile", 100);
  expect(cachedComposerPrediction(request, "cache-profile", 101)).toBe("Next step?");
  expect(cachedComposerPrediction(request, "other-profile", 101)).toBeNull();
  expect(cachedComposerPrediction({ ...request, client_metadata: base.client_metadata }, "cache-profile", 101)).toBeNull();
  expect(cachedComposerPrediction({ ...request, input: [{ role: "user", content: "Changed user." }, ...request.input.slice(1)] }, "cache-profile", 101)).toBeNull();
  expect(cachedComposerPrediction({ ...request, input: [body.input[0], { role: "assistant", content: "Changed final." }, ...base.input] }, "cache-profile", 101)).toBeNull();
  expect(cachedComposerPrediction(request, "cache-profile", 100 + COMPOSER_PREDICTION_TTL_MS - 1)).toBe("Next step?");
  expect(cachedComposerPrediction(request, "cache-profile", 100 + COMPOSER_PREDICTION_TTL_MS)).toBeNull();
});

test.each([false, true])("completion replay cannot renew prediction TTL after expiration=%s", expired => {
  const body = { model: CHATGPT_WEB_MODEL_ID, input: [{ role: "user", content: "Preserve the original deadline." }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: `replay-parent-${expired}` }) } };
  const parsed = parseRequest(body);
  parsed._composerPrediction = { enabled: true, suggestion: "Review the diff." };
  const response = { status: "completed", output: [{ type: "message", role: "assistant",
    content: [{ type: "output_text", text: "Original completed answer." }] }] };
  const request = { ...body, input: [...body.input, { role: "assistant", content: "Original completed answer." }, ...base.input],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata, forked_from_thread_id: `replay-parent-${expired}` }) } };
  const namespace = `replay-ttl-${expired}`, deadline = 100 + COMPOSER_PREDICTION_TTL_MS;
  rememberComposerPrediction(parsed, response, namespace, 100);
  const replay = parseRequest(body);
  replay._composerPrediction = { ...parsed._composerPrediction };
  if (expired) expect(cachedComposerPrediction(request, namespace, deadline)).toBeNull();
  rememberComposerPrediction(replay, response, namespace, deadline + (expired ? 1 : -1));
  expect(cachedComposerPrediction(request, namespace, deadline + 2)).toBeNull();
});

test("production runtime publishes a same-final suggestion only after successful browser settlement", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-same-final-runtime-"));
  const socket = defaultBrokerEndpoint(root), broker = TurnBroker.forSocket(socket);
  const capabilities = { localToolsEnabled: true, solAvailable: true, proAvailable: false };
  try {
    await broker.listen();
    for (const fail of [false, true]) {
      const parsed = parseRequest({ model: CHATGPT_WEB_MODEL_ID, input: [{ type: "message", role: "user", id: `user-${fail}`,
        internal_chat_message_metadata_passthrough: { turn_id: `runtime-${fail}` }, content: "Check this change." }],
        tools: [{ type: "function", name: "Read", parameters: { type: "object" } }],
        client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "runtime-parent", turn_id: `runtime-${fail}` }) } });
      parsed._composerPrediction = { enabled: true };
      let settled: () => void = () => {};
      const afterAcceptance = new Promise<void>(resolve => { settled = resolve; });
      const starter = createChatGptRuntimeStarter({ provider: { adapter: "chatgpt-web", baseUrl: "http://localhost" },
        broker, brokerOwner: new RemoteTurnBroker(socket), useEnhancedWebSessionMode: true, useEnhancedOutputTunnel: true,
        experimentalFreshConversationPerTurn: false, experimentalBiggerContext: false, experimentalSkillAttachments: false,
        configuredCapabilities: capabilities, executionNamespace: "prediction-runtime", lunaCheckpointStore: new ChatGptLunaCheckpointStore(),
        enhancedRecoveryCheckpointStore: new EnhancedRecoveryCheckpointStore(), worker: { async run(turn) {
          const prepared = await turn.prepare!();
          expect(prepared.text).toContain("next_message_prediction");
          await submitNativeOutputControl(socket, prepared.turnToken!, { kind: "final", text: "Atomic runtime answer.",
            next_message_prediction: "Show details." }, undefined);
          expect(parsed._composerPrediction?.suggestion).toBeUndefined();
          settled();
          const result = await runChatGptTunneledOutputTurn({ output: turn.tunneledOutput!, completionFence: turn.completionFence,
            observe: async () => ({ running: false, responsePresent: true }), onFinal: () => {}, attempt: 1, pollMs: 1 });
          if (fail) throw new Error("Browser settlement failed");
          if (result.status !== "complete") throw new Error("Expected Native completion");
          return result.answer;
        } } });
      const runtime = starter(parsed, { cwd: root, roots: [root], writableRoots: [root],
        sandboxPolicy: { type: "dangerFullAccess" }, tools: parsed.context.tools! }, `prediction-runtime-${fail}`, capabilities);
      const result = runtime.browser.then(value => ({ value }), error => ({ error }));
      await afterAcceptance;
      if (fail) { expect(await result).toHaveProperty("error"); expect(parsed._composerPrediction.suggestion).toBeUndefined(); }
      else { expect(await result).toEqual({ value: "Atomic runtime answer." }); expect(parsed._composerPrediction.suggestion).toBe("Show details.");
        expect(parsed._composerPrediction).toHaveProperty("completedAt", expect.any(Number)); }
      if (runtime.mode === "tools") await broker.revoke(await runtime.token);
    }
  } finally { await broker.close(); rmSync(root, { recursive: true, force: true }); }
});

test("all prompt consumers include the opt-in contract from the authoritative parsed state", () => {
  const parsed = parseRequest({ model: CHATGPT_WEB_MODEL_ID, input: [{ role: "user", content: "Review." }],
    tools: [{ type: "function", name: "Read", parameters: { type: "object" } }] });
  const options = { nativeControlConnector: true, useEnhancedOutputTunnel: true };
  const capabilities = { localToolsEnabled: true, solAvailable: true, proAvailable: false };
  const token = "turn_12345678901234567890123456789012";
  expect(compileChatGptWebPrompt(parsed, capabilities, token, options).text).not.toContain("next_message_prediction");
  parsed._composerPrediction = { enabled: true };
  expect(compileChatGptWebPrompt(parsed, capabilities, token, options).text).toContain("next_message_prediction");
});

test("the production adapter carries same-final metadata into a new canonical tool-result request", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-prediction-round-"));
  const socket = defaultBrokerEndpoint(root), broker = TurnBroker.forSocket(socket);
  const environment = `<environment_context><cwd>${root}</cwd><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></environment_context>`;
  const body = { model: CHATGPT_WEB_MODEL_ID, tools: [{ type: "function", name: "Read", parameters: { type: "object" } }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: root, turn_id: "prediction-tool-turn" }) },
    input: [environment, "Review this change."].map(text => ({ type: "message", role: "user",
      content: [{ type: "input_text", text }], internal_chat_message_metadata_passthrough: { turn_id: "prediction-tool-turn" } })) };
  const first = parseRequest(body);
  first._canonicalContextComplete = true;
  first._composerPrediction = { enabled: true };
  const adapter = createChatGptWebAdapter({ adapter: "chatgpt-web", baseUrl: `browser://${root}`,
    chatgptWeb: { localToolsEnabled: true, useEnhancedWebSessionMode: true, useEnhancedOutputTunnel: true,
      brokerSocketPath: socket } }, { broker, worker: { async run(turn) {
        const prepared = await turn.prepare();
        const activityId = "activity_1234567890123456";
        const claimed = await callTurnBroker<{ bindingId: string }>(socket, { method: "claim", token: prepared.turnToken, activityId });
        const invocation = callTurnBroker(socket, { method: "invoke", bindingId: claimed.bindingId, wireName: "Read", freeform: false,
          arguments: { path: "change.txt" } });
        const progress = turn.externalProgress!;
        let snapshot = progress.snapshot();
        while (!snapshot.lastToolBatchRevision) snapshot = await progress.waitForChange(snapshot.revision, turn.abortSignal);
        await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
        await invocation;
        await callTurnBroker(socket, { method: "activity_complete", token: prepared.turnToken, activityId });
        await submitNativeOutputControl(socket, prepared.turnToken!, { kind: "final", text: "Reviewed change.",
          next_message_prediction: "Show the change." }, undefined);
        const result = await runChatGptTunneledOutputTurn({ output: turn.tunneledOutput!, completionFence: turn.completionFence,
          observe: async () => ({ running: false, responsePresent: true }), onFinal: turn.onTextDelta, attempt: 1, pollMs: 1 });
        prepared.release();
        if (result.status !== "complete") throw new Error("Expected Native completion");
        return result.answer;
      } } });
  try {
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(first, { headers: new Headers() }, event => events.push(event));
    const tool = events.find(event => event.type === "tool_call_start");
    expect(tool?.type).toBe("tool_call_start");
    if (tool?.type !== "tool_call_start") throw new Error("Tool batch missing");
    const next = parseRequest({ ...body, input: [...body.input,
      { type: "function_call", call_id: tool.id, name: "Read", arguments: '{"path":"change.txt"}' },
      { type: "function_call_output", call_id: tool.id, output: "Change contents." }] });
    next._canonicalContextComplete = true;
    next._composerPrediction = { enabled: true };
    const finalEvents: AdapterEvent[] = [];
    await adapter.runTurn!(next, { headers: new Headers() }, event => finalEvents.push(event));
    expect(finalEvents.at(-1)?.type).toBe("done");
    expect(next._composerPrediction.suggestion).toBe("Show the change.");
    expect(next._composerPrediction).toHaveProperty("completedAt", expect.any(Number));
    expect(next._composerPrediction).toEqual(first._composerPrediction);
    const replay = parseRequest(next._rawBody);
    replay._canonicalContextComplete = true;
    replay._composerPrediction = { enabled: true };
    await adapter.runTurn!(replay, { headers: new Headers() }, () => {});
    expect(replay._composerPrediction.suggestion).toBe("Show the change.");
    expect(replay._composerPrediction).toEqual(next._composerPrediction);
  } finally { chatGptTurnSessions.clear(); await broker.close(); rmSync(root, { recursive: true, force: true }); }
});
