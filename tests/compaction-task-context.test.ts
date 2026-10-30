import { expect, test } from "bun:test";
import { isDeepStrictEqual } from "node:util";
import { defaultConfig } from "../src/config";
import { compactRequest, responseRequest } from "../src/server";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { rememberCompactionContinuation, restoreCompactionTaskMessages } from "../src/adapters/chatgpt-web/compaction-continuation";
import { chatGptTurnUserRevisionHistory, extractChatGptCompactionSourceRevision, extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { parseRequest } from "../src/responses/parser";
import { encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

const model = "chatgpt-web/high";
const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };

for (const format of ["v1", "v2"] as const) {
  for (const kind of ["goal", "delegation"] as const) {
    for (const steering of [false, true]) {
      test(`${format} restores dropped ${kind} to model context, preserving later steering=${steering}`, async () => {
        const turn = `turn_${format}_${kind}_${steering}`;
        const metadata = { thread_id: `thread_${turn}`, turn_id: turn };
        const human = { type: "message", role: "user", id: "msg_human", content: [{ type: "input_text", text: "Report the goal status only." }],
          internal_chat_message_metadata_passthrough: { turn_id: "earlier", content_item_kinds: ["user.text"] } };
        const taskText = kind === "goal"
          ? '<codex_internal_context source="goal">Implement the next checked milestone.</codex_internal_context>'
          : '<codex_delegation><source_thread_id>coordinator</source_thread_id><input>Implement the next checked milestone.</input></codex_delegation>';
        const task = kind === "goal"
          ? { type: "message", role: "user", id: "msg_task", content: taskText,
            internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: ["goal.internal_context"] } }
          : { type: "function_call_output", id: "fco_task", name: "send_message_to_thread", namespace: "codex_app",
            output: taskText, internal_chat_message_metadata_passthrough: { turn_id: turn } };
        const body = { model, stream: false, input: [human, task],
          tools: [{ type: "function", name: "exec_command", parameters: { type: "object", properties: {} } }],
          client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) } };
        const config = defaultConfig("full");
        const compactFactory = () => ({ name: "task-context-compactor", async runTurn(_p: any, _i: any, emit: any) {
          emit({ type: "text_delta", text: "The earlier status check is complete. Continue implementation.", phase: "final_answer" });
          emit({ type: "done", stopReason: "stop", endTurn: true });
        } });
        const compact = format === "v1"
          ? await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", { method: "POST", body: JSON.stringify(body) }), config, compactFactory)
          : await responseRequest(new Request("http://127.0.0.1/v1/responses", { method: "POST",
            body: JSON.stringify({ ...body, input: [...body.input, { type: "compaction_trigger" }] }) }), config, compactFactory);
        expect(compact.status).toBe(200);
        const result = await compact.json() as { output: Array<Record<string, unknown>> };
        // Native process_annotated_compacted_history drops goal/model context and synthetic inputs.
        const retained = result.output.filter(item => item.id !== task.id);
        const input: unknown[] = format === "v1" ? retained : [human, ...retained];
        if (steering) input.push({ type: "message", role: "user", id: "msg_new_steering", content: "Stop and report the new steering request.",
          internal_chat_message_metadata_passthrough: { turn_id: turn } });
        input.push({ type: "function_call", call_id: "call_after_compact", name: "exec_command", arguments: "{}" },
          { type: "function_call_output", call_id: "call_after_compact", output: "LATEST_TOOL_RESULT" });
        const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", { method: "POST",
          body: JSON.stringify({ ...body, input }) }), config, () => ({ name: "model-context-observer", async runTurn(parsed: any, _i: any, emit: any) {
            const before = JSON.stringify(parsed.context.messages);
            for (const experimentalMultipartParts of [undefined, 2] as const) {
              const prompt = compileChatGptWebPrompt(parsed, capabilities, "turn_12345678901234567890123456789012", { experimentalMultipartParts });
              const match = prompt.text.match(/<codex_context_json>\n([^\n]+)\n<\/codex_context_json>/);
              const messages = prompt.multipart ? prompt.multipart.parts.flatMap(part => JSON.parse(part).records)
                .filter(record => record.kind === "message").map(record => record.message)
                : JSON.parse(match![1]!).messages;
              const tasks = messages.filter((m: any) => m.content === taskText);
              if (steering) {
                expect(tasks).toHaveLength(0);
                expect(messages.some((m: any) => m.content === "Stop and report the new steering request.")).toBe(true);
              } else {
                expect(tasks).toHaveLength(1);
                expect(tasks[0].role).toBe(kind === "goal" ? "user" : "agent_message");
                expect(messages.indexOf(tasks[0])).toBeLessThan(messages.findIndex((m: any) => m.content === "LATEST_TOOL_RESULT"));
              }
            }
            expect(JSON.stringify(parsed.context.messages)).toBe(before);
            emit({ type: "text_delta", text: "Observed model-facing context", phase: "final_answer" });
            emit({ type: "done", stopReason: "stop", endTurn: true });
          } }), { rememberState: false });
        const observed = await response.json();
        expect(response.status).toBe(200);
        expect(observed).toMatchObject({ status: "completed" });
      });
    }
  }
}

test("task restoration preserves repeated authenticated checkpoints and rejects changed scope/history", () => {
  const identity = { threadId: "task_restore_guards", turnId: "goal_turn" };
  const human = { type: "message", role: "user", id: "human", content: "Earlier task",
    internal_chat_message_metadata_passthrough: { turn_id: "old_turn" } };
  const task = { type: "message", role: "user", id: "goal", content: "Current native goal",
    internal_chat_message_metadata_passthrough: { turn_id: "goal_turn", content_item_kinds: ["goal.internal_context"] } };
  const source = { itemId: task.id, turnId: "goal_turn", content: task.content };
  const retained = { itemId: human.id, turnId: "old_turn", content: human.content };
  const body = { model, input: [human, task], client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({ thread_id: identity.threadId, turn_id: identity.turnId }),
  } };
  const first = parseRequest(body);
  first._compactionRequest = true;
  rememberCompactionContinuation(first, identity, [source, retained], "First exact summary");
  const compacted = { type: "compaction", encrypted_content: encodeCompactionSummary("First exact summary") };
  const replay = parseRequest({ ...body, input: [human, compacted] });
  const restore = (parsed: ReturnType<typeof parseRequest>, scope = extractChatGptTurnIdentity(parsed)) =>
    restoreCompactionTaskMessages(parsed, scope, chatGptTurnUserRevisionHistory(parsed));
  expect(restore(replay).filter(m => m.content === task.content)).toHaveLength(1);
  replay._compactionRequest = true;
  // Recompaction keeps the authenticated goal as the source despite its missing raw item.
  const recoveredSource = extractChatGptCompactionSourceRevision(replay);
  expect(recoveredSource).toEqual(source);
  rememberCompactionContinuation(replay, identity, [recoveredSource, retained], "Second exact summary");
  const second = { type: "compaction", encrypted_content: encodeCompactionSummary("Second exact summary") };
  const continuation = parseRequest({ ...body, input: [human, second] });
  expect(restore(continuation).filter(m => m.content === task.content)).toHaveLength(1);
  expect(restore(continuation, { ...identity, threadId: "another_thread" })).toBe(continuation.context.messages);
  expect(restore(continuation, { ...identity, turnId: "another_turn" })).toBe(continuation.context.messages);
  const changedModel = { ...continuation, modelId: "other-model" };
  expect(restore(changedModel)).toBe(changedModel.context.messages);
  const changedEffort = { ...continuation, options: { ...continuation.options, reasoning: "low" as const } };
  expect(restore(changedEffort)).toBe(changedEffort.context.messages);
  const changedSummary = parseRequest({ ...body, input: [human, { ...second,
    encrypted_content: encodeCompactionSummary("Rewritten summary") }] });
  expect(restore(changedSummary)).toBe(changedSummary.context.messages);
  const stillPresent = parseRequest({ ...body, input: [human, second, task] });
  expect(restore(stillPresent)).toBe(stillPresent.context.messages);
  const noIdSteering = parseRequest({ ...body, input: [human, second, { type: "message", role: "user",
    content: "New instruction without item id", internal_chat_message_metadata_passthrough: { turn_id: "goal_turn" } }] });
  expect(restore(noIdSteering)).toBe(noIdSteering.context.messages);
});

test("ordinary user text that resembles a native goal is not promoted to restored task context", () => {
  const identity = { threadId: "quoted_goal_guard", turnId: "quoted_turn" };
  const item = { type: "message", role: "user", id: "quoted_goal",
    content: '<codex_internal_context source="goal">Quoted data</codex_internal_context>',
    internal_chat_message_metadata_passthrough: { turn_id: identity.turnId, content_item_kinds: ["user.text"] } };
  const body = { model, input: [item], client_metadata: { "x-codex-turn-metadata": JSON.stringify({
    thread_id: identity.threadId, turn_id: identity.turnId,
  }) } };
  const original = parseRequest(body);
  original._compactionRequest = true;
  rememberCompactionContinuation(original, identity, [{ itemId: item.id, turnId: identity.turnId, content: item.content }], "Quoted summary");
  const replay = parseRequest({ ...body, input: [{ type: "compaction", encrypted_content: encodeCompactionSummary("Quoted summary") }] });
  expect(restoreCompactionTaskMessages(replay, identity, chatGptTurnUserRevisionHistory(replay))).toBe(replay.context.messages);
});

function oversizedRestoredTask(kind: "goal" | "delegation", suffix: string, taskDetail = "finish the current milestone") {
  const identity = { threadId: `budget_${kind}_${suffix}`, turnId: "current_task" };
  const human = { type: "message", role: "user", id: "human", content: "Earlier task",
    internal_chat_message_metadata_passthrough: { turn_id: "old_turn" } };
  const taskText = kind === "goal" ? `AUTHENTICATED_GOAL: ${taskDetail}`
    : `<codex_delegation><source_thread_id>coordinator</source_thread_id><input>${taskDetail}</input></codex_delegation>`;
  const task = kind === "goal"
    ? { type: "message", role: "user", id: "task", content: taskText,
        internal_chat_message_metadata_passthrough: { turn_id: identity.turnId, content_item_kinds: ["goal.internal_context"] } }
    : { type: "function_call_output", id: "task", name: "send_message_to_thread", namespace: "codex_app", output: taskText,
        internal_chat_message_metadata_passthrough: { turn_id: identity.turnId } };
  const body = { model: CHATGPT_WEB_MODEL_ID, reasoning: { effort: "high" }, input: [human, task],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: identity.threadId, turn_id: identity.turnId }) } };
  const original = parseRequest(body);
  original._compactionRequest = true;
  original._chatgptModelFamily = "6";
  rememberCompactionContinuation(original, identity, [
    { itemId: task.id, turnId: identity.turnId, content: taskText },
    { itemId: human.id, turnId: "old_turn", content: human.content },
  ], "Exact cumulative summary");
  const replay = parseRequest({ ...body, input: [human,
    { type: "compaction", encrypted_content: encodeCompactionSummary("Exact cumulative summary") },
    ...Array.from({ length: 8 }, (_, index) => ({ type: "message", role: "assistant",
      content: [{ type: "output_text", text: `history-${index}:` + " observed detail".repeat(20_000) }] })),
  ] });
  replay._compactionRequest = true;
  replay._chatgptModelFamily = "6";
  // The real compact handler appends this instruction after authenticating the native history.
  replay.context.messages.push({ role: "user", content: "FINAL_COMPACT_INSTRUCTION: summarize remaining work", timestamp: Date.now() });
  return { replay, taskText, task };
}

for (const kind of ["goal", "delegation"] as const) for (const parts of [undefined, 6] as const) {
  test(`over-budget ${parts ?? "inline"} compaction preserves the authenticated restored ${kind}`, () => {
    const { replay, taskText } = oversizedRestoredTask(kind, String(parts));
    const before = structuredClone(replay.context.messages);
    expect(restoreCompactionTaskMessages(replay, extractChatGptTurnIdentity(replay), chatGptTurnUserRevisionHistory(replay))
      .filter(message => message.content === taskText)).toHaveLength(1);
    const compiled = compileChatGptWebPrompt(replay, { ...capabilities, localToolsEnabled: false }, undefined,
      { experimentalMultipartParts: parts });
    expect(compiled.trimmedCompactionMessages).toBeGreaterThan(0);
    const messages = compiled.multipart ? compiled.multipart.parts.flatMap(part => JSON.parse(part).records)
      .filter((record: any) => record.kind === "message").map((record: any) => record.message)
      : JSON.parse(compiled.text.match(/<codex_context_json>\n([^\n]+)\n<\/codex_context_json>/)![1]!).messages;
    const tasks = messages.filter((message: any) => message.content === taskText);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].role).toBe(kind === "goal" ? "user" : "agent_message");
    expect(JSON.stringify(messages)).toContain("Exact cumulative summary");
    expect(JSON.stringify(messages.at(-1))).toContain("FINAL_COMPACT_INSTRUCTION");
    expect(isDeepStrictEqual(replay.context.messages, before)).toBeTrue();
  }, 30_000);
}

test("an irreducible authenticated task fails rather than being removed from compaction", () => {
  const { replay } = oversizedRestoredTask("goal", "irreducible", " mandatory current task".repeat(160_000));
  const before = structuredClone(replay.context.messages);
  let failure: unknown;
  try {
    compileChatGptWebPrompt(replay, { ...capabilities, localToolsEnabled: false }, undefined,
      { experimentalMultipartParts: 6 });
  } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: "context_length_exceeded", retryable: false, status: 400 });
  expect((failure as Error).message).toContain("after other history was trimmed");
  expect(isDeepStrictEqual(replay.context.messages, before)).toBeTrue();
}, 30_000);

for (const steering of ["user", "parent"] as const) for (const parts of [undefined, 6] as const) {
  test(`over-budget ${parts ?? "inline"} compaction keeps current ${steering} steering after a checkpoint`, () => {
    const { replay, taskText } = oversizedRestoredTask("goal", `steering_${steering}_${parts}`);
    const identity = extractChatGptTurnIdentity(replay);
    const raw = replay._rawBody as { input: unknown[]; [key: string]: unknown };
    const instruction = steering === "user" ? "NEW_STEERING: stop implementation and audit the current changes"
      : '<codex_delegation><source_thread_id>coordinator</source_thread_id><input>NEW_PARENT_STEERING: review only, do not implement</input></codex_delegation>';
    const item = steering === "user"
      ? { type: "message", role: "user", id: "steering", content: instruction,
          internal_chat_message_metadata_passthrough: { turn_id: identity.turnId, content_item_kinds: ["user.text"] } }
      : { type: "function_call_output", id: "steering", name: "send_message_to_thread", namespace: "codex_app", output: instruction,
          internal_chat_message_metadata_passthrough: { turn_id: identity.turnId } };
    const parsed = parseRequest({ ...raw, input: [...raw.input.slice(0, 2), item, ...raw.input.slice(2)] });
    parsed._compactionRequest = true; parsed._chatgptModelFamily = "6";
    parsed.context.messages.push({ role: "user", content: "FINAL_COMPACT_INSTRUCTION", timestamp: Date.now() });
    const before = structuredClone(parsed.context.messages);
    const compiled = compileChatGptWebPrompt(parsed, { ...capabilities, localToolsEnabled: false }, undefined,
      { experimentalMultipartParts: parts });
    expect(compiled.trimmedCompactionMessages).toBeGreaterThan(1);
    const messages = compiled.multipart ? compiled.multipart.parts.flatMap(part => JSON.parse(part).records)
      .filter((record: any) => record.kind === "message").map((record: any) => record.message)
      : JSON.parse(compiled.text.match(/<codex_context_json>\n([^\n]+)\n<\/codex_context_json>/)![1]!).messages;
    expect(messages.filter((message: any) => message.content === instruction)).toHaveLength(1);
    expect(messages.some((message: any) => message.content === taskText)).toBeFalse();
    expect(JSON.stringify(messages)).toContain("Exact cumulative summary");
    expect(messages.at(-1).content).toBe("FINAL_COMPACT_INSTRUCTION");
    expect(isDeepStrictEqual(parsed.context.messages, before)).toBeTrue();
  }, 30_000);
}

test.each([undefined, 6] as const)("over-budget compaction also pins an already-present native task (parts=%s)", parts => {
  const { replay, taskText, task } = oversizedRestoredTask("goal", `present_${parts}`);
  const raw = replay._rawBody as { input: unknown[]; [key: string]: unknown };
  const parsed = parseRequest({ ...raw, input: [raw.input[0], task, ...raw.input.slice(1)] });
  parsed._compactionRequest = true; parsed._chatgptModelFamily = "6";
  parsed.context.messages.push({ role: "user", content: "FINAL_COMPACT_INSTRUCTION", timestamp: Date.now() });
  const compiled = compileChatGptWebPrompt(parsed, { ...capabilities, localToolsEnabled: false }, undefined,
    { experimentalMultipartParts: parts });
  expect(compiled.trimmedCompactionMessages).toBeGreaterThan(1);
  const messages = compiled.multipart ? compiled.multipart.parts.flatMap(part => JSON.parse(part).records)
    .filter((record: any) => record.kind === "message").map((record: any) => record.message)
    : JSON.parse(compiled.text.match(/<codex_context_json>\n([^\n]+)\n<\/codex_context_json>/)![1]!).messages;
  expect(messages.filter((message: any) => message.content === taskText)).toHaveLength(1);
}, 30_000);

test("text-parts checkpoint keeps repeated steering in its new position, not the older matching user record", () => {
  const { replay } = oversizedRestoredTask("goal", "repeated_parts_steering");
  const raw = replay._rawBody as { input: Array<Record<string, unknown>>; [key: string]: unknown };
  const instruction = raw.input[0]!.content;
  const checkpoint = { type: "message", role: "user", content: [
    { type: "input_text", text: SUMMARY_PREFIX }, { type: "input_text", text: "Exact cumulative summary" },
  ] };
  const steering = { type: "message", role: "user", id: "repeated-steering", content: instruction,
    internal_chat_message_metadata_passthrough: { turn_id: extractChatGptTurnIdentity(replay).turnId } };
  const parsed = parseRequest({ ...raw, input: [raw.input[0], checkpoint, steering, ...raw.input.slice(2)] });
  parsed._compactionRequest = true; parsed._chatgptModelFamily = "6";
  parsed.context.messages.push({ role: "user", content: "FINAL_COMPACT_INSTRUCTION", timestamp: 0 });
  const compiled = compileChatGptWebPrompt(parsed, { ...capabilities, localToolsEnabled: false });
  const messages = JSON.parse(compiled.text.match(/<codex_context_json>\n([^\n]+)\n<\/codex_context_json>/)![1]!).messages;
  const checkpointIndex = messages.findIndex((message: any) => JSON.stringify(message.content).includes("Exact cumulative summary"));
  expect(checkpointIndex).toBeGreaterThanOrEqual(0);
  expect(messages.findIndex((message: any) => message.content === instruction)).toBeGreaterThan(checkpointIndex);
  expect(messages.filter((message: any) => message.content === instruction)).toHaveLength(1);
});

test("first over-budget compaction pins its native task before any accepted checkpoint exists", () => {
  const { replay, taskText, task } = oversizedRestoredTask("goal", "first_compact_task");
  const raw = replay._rawBody as { input: unknown[]; [key: string]: unknown };
  const parsed = parseRequest({ ...raw, input: [raw.input[0], task, ...raw.input.slice(2)] });
  parsed._compactionRequest = true; parsed._chatgptModelFamily = "6";
  parsed.context.messages.push({ role: "user", content: "FINAL_COMPACT_INSTRUCTION", timestamp: 0 });
  const compiled = compileChatGptWebPrompt(parsed, { ...capabilities, localToolsEnabled: false });
  expect(compiled.trimmedCompactionMessages).toBeGreaterThan(1);
  const messages = JSON.parse(compiled.text.match(/<codex_context_json>\n([^\n]+)\n<\/codex_context_json>/)![1]!).messages;
  expect(messages.filter((message: any) => message.content === taskText)).toHaveLength(1);
});

test("compaction rejects a model view that no longer contains the authenticated instruction", () => {
  const { replay, task, taskText } = oversizedRestoredTask("goal", "mismatched_model_view");
  const raw = replay._rawBody as { input: unknown[]; [key: string]: unknown };
  const parsed = parseRequest({ ...raw, input: [raw.input[0], task, ...raw.input.slice(2)] });
  parsed._compactionRequest = true; parsed._chatgptModelFamily = "6";
  parsed.context.messages.find(message => message.content === taskText)!.content += " model-only modification";
  let failure: unknown;
  try { compileChatGptWebPrompt(parsed, { ...capabilities, localToolsEnabled: false }); }
  catch (error) { failure = error; }
  expect(failure).toMatchObject({ status: 409, code: "compaction_source_unavailable", retryable: false });
});
