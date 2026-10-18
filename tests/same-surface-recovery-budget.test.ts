import { expect, spyOn, test } from "bun:test";
import { chatGptCompletionEvidenceError } from "../src/adapters/chatgpt-web/adapter-error";
import { createChatGptSameSurfaceRetry } from "../src/adapters/chatgpt-web/same-surface-recovery";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import type { ChatGptRetryPrompt } from "../src/adapters/chatgpt-web/steering";

async function fixture(run: (state: {
  retry: NonNullable<ReturnType<typeof createChatGptSameSurfaceRetry>>;
  session: ChatGptTurnSession;
  progress: ChatGptExternalTurnProgress;
  abort: AbortController;
}) => Promise<void>) {
  const progress = new ChatGptExternalTurnProgress(), abort = new AbortController();
  const session = new ChatGptTurnSession({ mode: "tools", token: Promise.resolve("turn_budget_fixture"),
    browser: new Promise<string>(() => {}), trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    externalProgress: progress, cancel: () => {} });
  session.observeCanonicalRequest({ modelId: "chatgpt-web/high", stream: true,
    context: { tools: [], messages: [] }, options: {}, _canonicalContextComplete: true });
  const find = spyOn(chatGptTurnSessions, "find").mockImplementation(() => session);
  try {
    const retry = createChatGptSameSurfaceRetry({ traceId: "budget_fixture", executionKey: "budget_fixture",
      enhancedMode: true, outputTunnel: true, turnToken: () => "turn_budget_fixture", abortSignal: abort.signal })!;
    await run({ retry, session, progress, abort });
  } finally { find.mockRestore(); progress.retire(new Error("fixture complete")); }
}

const failure = () => chatGptCompletionEvidenceError("stopped without final", false);
function submitted(value: string | ChatGptRetryPrompt | undefined): ChatGptRetryPrompt {
  expect(value).toBeDefined();
  if (!value || typeof value === "string") throw new Error("Expected bound recovery prompt");
  value.onSubmitted?.();
  return value;
}

test("completed new Native work earns one recovery without resetting the browser attempt", async () => {
  await fixture(async ({ retry, session, progress }) => {
    submitted(await retry(failure(), 1));
    expect(await retry(failure(), 2)).toBeUndefined();
    progress.recordBrokerActivity();
    session.runtime.trace.recordProgress();
    expect(await retry(failure(), 2)).toBeUndefined();
    session.setOutstanding([{ callId: "call_new_work", wireName: "exec_command", freeform: false, arguments: {} }]);
    expect(await retry(failure(), 2)).toBeUndefined();
    session.markResultDelivered("call_new_work");
    submitted(await retry(failure(), 2));
    expect(await retry(failure(), 3)).toBeUndefined();
    session.setOutstanding([{ callId: "call_more_work", wireName: "exec_command", freeform: false, arguments: {} }]);
    session.markResultDelivered("call_more_work");
    submitted(await retry(failure(), 3));
    expect(await retry(failure(), 4)).toBeUndefined();
  });
});

test("an earlier steering response does not consume the first missing-final recovery", async () => {
  await fixture(async ({ retry }) => {
    submitted(await retry(failure(), 3));
    expect(await retry(failure(), 4)).toBeUndefined();
  });
});

test("cancelled recovery candidates do not consume the submission budget", async () => {
  await fixture(async ({ retry }) => {
    expect(await retry(failure(), 1)).toBeDefined();
    submitted(await retry(failure(), 1));
    expect(await retry(failure(), 2)).toBeUndefined();
  });
});

test("superseded calls and partial batches cannot renew recovery", async () => {
  await fixture(async ({ retry, session }) => {
    submitted(await retry(failure(), 1));
    session.setOutstanding([{ callId: "call_cancelled", wireName: "exec_command", freeform: false, arguments: {} }]);
    session.supersedeOutstanding();
    session.observeCanonicalRequest({ modelId: "chatgpt-web/high", stream: true,
      context: { tools: [], messages: [] }, options: {}, _canonicalContextComplete: true });
    expect(await retry(failure(), 2)).toBeUndefined();
    session.setOutstanding(["call_a", "call_b"].map(callId => ({ callId, wireName: "exec_command", freeform: false, arguments: {} })));
    session.markResultDelivered("call_a");
    expect(await retry(failure(), 2)).toBeUndefined();
    session.markResultDelivered("call_b");
    submitted(await retry(failure(), 2));
  });
});

test.each(["compact", "abort", "canonical"])("new work cannot bypass %s ownership", async boundary => {
  await fixture(async ({ retry, session, abort }) => {
    submitted(await retry(failure(), 1));
    session.setOutstanding([{ callId: "call_new", wireName: "exec_command", freeform: false, arguments: {} }]);
    session.markResultDelivered("call_new");
    if (boundary === "compact") session.runtime.compactionRequested = true;
    if (boundary === "abort") abort.abort();
    if (boundary === "canonical") session.observeCanonicalRequest({ modelId: "chatgpt-web/high", stream: true,
      context: { tools: [], messages: [] }, options: {} });
    expect(await retry(failure(), 2)).toBeUndefined();
  });
});
