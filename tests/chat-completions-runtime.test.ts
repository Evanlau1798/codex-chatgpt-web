import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig } from "../src/config";
import { createChatCompletionExecutor, activeChatCompletionTurns } from "../src/chat-completions/runtime";
import { parseChatCompletion, chatOutputTokens } from "../src/chat-completions/contract";
import { ChatGptAccountSafety } from "../src/adapters/chatgpt-web/account-safety";
import { ChatGptPersistentBrowserStateError } from "../src/browser-mutation";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";

const req = (extra: Record<string, unknown> = {}) => parseChatCompletion({ model: "chatgpt-web/high", messages: [{ role: "user", content: "safe test" }], ...extra });
function fixture() { const dir = mkdtempSync(join(tmpdir(), "chat-api-")); return { safety: new ChatGptAccountSafety(join(dir, "safety.json")), dispose: () => rmSync(dir, { force: true, recursive: true }) }; }

test("production runtime uses fresh worker turns with no native/tool/retained capability even in Full config", async () => {
  const f = fixture(); const config = defaultConfig("full"); config.useEnhancedWebSessionMode = true;
  config.useEnhancedOutputTunnel = true; config.experimentalBiggerContext = true; config.experimentalSkillAttachments = true;
  const turns: BrowserTurn[] = [];
  const execute = createChatCompletionExecutor({ safety: f.safety, worker(provider) {
    expect(provider.chatgptWeb).toMatchObject({ localToolsEnabled: false, useEnhancedWebSessionMode: false,
      useEnhancedOutputTunnel: false, experimentalBiggerContext: false, experimentalSkillAttachments: false, autoApproveToolCalls: false });
    return { async run(turn) {
      turns.push(turn); expect(activeChatCompletionTurns()).toBeGreaterThan(0);
      expect(turn.capabilities.localToolsEnabled).toBeFalse();
      for (const field of ["nativeConnector", "retainConversation", "conversationKey", "tunneledOutput", "completionFence", "compaction", "retryPromptForAnswer"]) expect(turn).not.toHaveProperty(field);
      const compiled = await turn.prepare(); expect(compiled.images).toEqual([]); expect(compiled.transport).toBe("inline");
      expect(compiled.turnToken).toBeUndefined(); compiled.release(); turn.onTextDelta("done"); return "done";
    } };
  } });
  try { await execute(req(), config, new AbortController().signal, () => {}); await execute(req(), config, new AbortController().signal, () => {});
    expect(turns[0]!.traceId).not.toBe(turns[1]!.traceId); expect(activeChatCompletionTurns()).toBe(0);
  } finally { f.dispose(); }
});

test("cancellation does not release active ownership before worker settlement", async () => {
  const f = fixture(); const abort = new AbortController(); let release!: () => void; let begun!: () => void;
  const ready = new Promise<void>(r => { begun = r; }); const held = new Promise<void>(r => { release = r; });
  const execute = createChatCompletionExecutor({ safety: f.safety, worker: () => ({ async run(turn) {
    await turn.prepare(); begun(); await held; turn.abortSignal!.throwIfAborted(); return "";
  } }) });
  const run = execute(req(), defaultConfig(), abort.signal, () => {}).catch(error => error);
  try { await ready; abort.abort(new DOMException("test", "AbortError")); await Promise.resolve();
    expect(activeChatCompletionTurns()).toBe(1); release(); expect((await run).name).toBe("AbortError"); expect(activeChatCompletionTurns()).toBe(0);
  } finally { release(); f.dispose(); }
});

test("output budget cancels generation, waits for cleanup and returns a valid token prefix", async () => {
  const f = fixture(); let cancelled = false; let emitted = "";
  const execute = createChatCompletionExecutor({ safety: f.safety, worker: () => ({ async run(turn) {
    await turn.prepare(); turn.onTextDelta("hello ".repeat(100)); cancelled = turn.abortSignal!.aborted;
    await Promise.resolve(); turn.abortSignal!.throwIfAborted(); return "unreachable";
  } }) });
  try { const result = await execute(req({ max_tokens: 5 }), defaultConfig(), new AbortController().signal, d => { emitted += d; });
    expect(result.limited).toBeTrue(); expect(cancelled).toBeTrue(); expect(result.answer).toBe(emitted); expect(chatOutputTokens(emitted)).toBeLessThanOrEqual(5);
  } finally { f.dispose(); }
});

test("cleanup failure after output limit is never disguised as successful length completion", async () => {
  const f = fixture(); const fail = new ChatGptPersistentBrowserStateError([], "unsettled test edit");
  const execute = createChatCompletionExecutor({ safety: f.safety, worker: () => ({ async run(turn) {
    turn.onTextDelta("hello ".repeat(100)); throw fail;
  } }) });
  try { await expect(execute(req({ max_tokens: 1 }), defaultConfig(), new AbortController().signal, () => {})).rejects.toBe(fail); }
  finally { f.dispose(); }
});

test("account guard counts sessions across general requests and blocks before the second browser", async () => {
  const f = fixture(); const config = defaultConfig(); config.automaticWebSessionLimitCount = 1; config.automaticWebSessionLimitMinutes = 300; let calls = 0;
  const execute = createChatCompletionExecutor({ safety: f.safety, worker: () => ({ async run(turn) { calls++; await turn.prepare(); return "done"; } }) });
  try { await execute(req(), config, new AbortController().signal, () => {});
    await expect(execute(req(), config, new AbortController().signal, () => {})).rejects.toMatchObject({ status: 429 }); expect(calls).toBe(1);
  } finally { f.dispose(); }
});
test("rate limit reported by the browser stops later general requests without retries", async () => {
  const f = fixture(); let calls = 0;
  const execute = createChatCompletionExecutor({ safety: f.safety, worker: () => ({ async run() {
    calls++; throw new ChatGptWebAdapterError("private detail", { status: 429, code: "rate_limit_exceeded", errorType: "rate_limit_error", retryable: false });
  } }) });
  try { await expect(execute(req(), defaultConfig(), new AbortController().signal, () => {})).rejects.toThrow();
    await expect(execute(req(), defaultConfig(), new AbortController().signal, () => {})).rejects.toMatchObject({ status: 429 }); expect(calls).toBe(1);
  } finally { f.dispose(); }
});

test("late text callbacks cannot publish after the original request settled", async () => {
  const f = fixture(); let captured!: BrowserTurn; let text = "";
  const execute = createChatCompletionExecutor({ safety: f.safety, worker: () => ({ async run(turn) { captured = turn; return "done"; } }) });
  try { await execute(req(), defaultConfig(), new AbortController().signal, delta => { text += delta; });
    captured.onTextDelta("late data"); captured.onHeartbeat?.(); expect(text).toBe("done");
  } finally { f.dispose(); }
});

test("split surrogate deltas are buffered until they form valid Unicode", async () => {
  const f = fixture(); const parts: string[] = [];
  const execute = createChatCompletionExecutor({ safety: f.safety, worker: () => ({ async run(turn) {
    turn.onTextDelta("\ud83d"); expect(parts).toEqual([]); turn.onTextDelta("\ude00"); return "😀";
  } }) });
  try { const result = await execute(req(), defaultConfig(), new AbortController().signal, delta => parts.push(delta));
    expect(parts).toEqual(["😀"]); expect(result.answer).toBe("😀");
  } finally { f.dispose(); }
});

test("only function-call turns request literal visible browser output", async () => {
  const f = fixture(); const formats: Array<string | undefined> = [];
  const execute = createChatCompletionExecutor({ safety: f.safety, worker: () => ({ async run(turn) {
    formats.push(turn.outputFormat);
    const answer = turn.outputFormat ? JSON.stringify({ content: "done", tool_calls: [] }) : "plain Markdown";
    turn.onTextDelta(answer); return answer;
  } }) });
  try {
    await execute(req(), defaultConfig(), new AbortController().signal, () => {});
    await execute(req({ tools: [{ type: "function", function: { name: "noop", parameters: { type: "object" } } }] }),
      defaultConfig(), new AbortController().signal, () => {});
    expect(formats).toEqual([undefined, "visible-text"]);
  } finally { f.dispose(); }
});

test("many small plain-text deltas do not repeatedly tokenize the full response", async () => {
  const f = fixture(); const answer = "a".repeat(3_000); let streamed = "";
  const execute = createChatCompletionExecutor({ safety: f.safety, worker: () => ({ async run(turn) {
    for (const character of answer) turn.onTextDelta(character);
    return answer;
  } }) });
  try {
    const result = await execute(req({ max_tokens: 65_536 }), defaultConfig(), new AbortController().signal,
      delta => { streamed += delta; });
    expect(streamed).toBe(answer); expect(result.answer).toBe(answer);
  } finally { f.dispose(); }
}, 5_000);

test("shared account-security drain cancels an active general turn instead of emitting new work", async () => {
  const f = fixture(); let wasAborted = false;
  const execute = createChatCompletionExecutor({ safety: f.safety, worker: () => ({ async run(turn) {
    await turn.prepare(); f.safety.trigger("account_security", [turn.traceId]); turn.onHeartbeat?.();
    wasAborted = turn.abortSignal!.aborted; turn.abortSignal!.throwIfAborted(); return "unreachable";
  } }) });
  try { await expect(execute(req(), defaultConfig(), new AbortController().signal, () => {})).rejects.toMatchObject({ code: "account_safety_paused" });
    expect(wasAborted).toBeTrue(); expect(activeChatCompletionTurns()).toBe(0);
  } finally { f.dispose(); }
});
