import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { runManualCompaction } from "../src/adapters/chatgpt-web/manual-compaction";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import { canonicalizeCompactionHandoff } from "../src/adapters/chatgpt-web/compaction-handoff";
import { deferred } from "../src/adapters/chatgpt-web/runtime-lifecycle";
import type { AdapterEvent, CodexParsedRequest, CodexToolResultMessage } from "../src/types";

for (const kind of ["missing", "duplicate", "valid", "locked"]) test(`manual active-tool compact requires complete canonical results: ${kind}`, async () => {
  const key = randomUUID(), browser = deferred<string>(), release = deferred<void>(), releasing = deferred<void>();
  let cancelled = false, started = false, prompt = "";
  const result: CodexToolResultMessage = { role: "toolResult", toolCallId: "call_one", toolName: "exec_command",
    content: "CANONICAL_RESULT_FIXTURE", isError: false, timestamp: 2 };
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, stream: true, options: { reasoning: "low" }, _compactionRequest: true,
    context: { tools: [], messages: [{ role: "user", content: "Inspect the project", timestamp: 1 },
      ...(kind === "missing" ? [] : kind === "duplicate" ? [result, result] : [result])] },
    _rawBody: { input: [{ type: "message", role: "user",
      content: [{ type: "input_text", text: "Inspect the project" }],
      internal_chat_message_metadata_passthrough: { turn_id: "source-turn" } }] },
  };
  const capabilities = { localToolsEnabled: true, solAvailable: false, proAvailable: false };
  const source = chatGptTurnSessions.getOrCreate(key, () => ({
    mode: "tools", token: Promise.resolve("fixture-token"), manualControl: { surfaceNonce: "fixture" },
    browser: browser.promise, trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    cancel: () => { cancelled = true; browser.resolve("cancelled"); },
    release: async () => { releasing.resolve(); await release.promise; },
  }));
  source.setOutstanding([{ callId: "call_one", wireName: "exec_command", freeform: false }]);
  const lock = kind === "locked" ? source.runExclusive(() => browser.promise) : Promise.resolve();
  const events: AdapterEvent[] = [];
  const run = runManualCompaction({ parsed, executionKey: `${key}:compact`, sourceKey: key,
    traceId: key, capabilities, emit: event => events.push(event), start: async () => {
      started = true;
      prompt = compileChatGptWebPrompt(parsed, capabilities, "fixture-request", { manualControl: true }).text;
      return chatGptTurnSessions.getOrCreate(`${key}:compact`, () => ({
        mode: "read-only", browser: Promise.resolve(canonicalizeCompactionHandoff(parsed, "Checkpoint summary.")!),
        trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {},
      }));
    },
  }).catch(error => error);
  try {
    if (kind === "missing" || kind === "duplicate") {
      release.resolve();
      await run;
      expect(events).toEqual([expect.objectContaining({ type: "error", code: "compaction_handoff_failed", retryable: false })]);
      expect(cancelled).toBe(false);
      expect(started).toBe(false);
      expect(chatGptTurnSessions.find(key)).toBe(source);
    } else {
      expect(await Promise.race([releasing.promise.then(() => true), Bun.sleep(100).then(() => false)])).toBe(true);
      expect(started).toBe(false);
      release.resolve();
      expect(await run).toBeUndefined();
      expect(cancelled).toBe(true);
      expect(prompt.split("CANONICAL_RESULT_FIXTURE")).toHaveLength(2);
      expect(source.outstanding()).toHaveLength(1); // No result is re-executed or fabricated on the retired owner.
      expect(chatGptTurnSessions.find(`${key}:compact`)).toBeUndefined();
    }
  } finally {
    release.resolve();
    await chatGptTurnSessions.retireAndWait(key);
    await chatGptTurnSessions.retireAndWait(`${key}:compact`);
    await run;
    await lock;
  }
});
