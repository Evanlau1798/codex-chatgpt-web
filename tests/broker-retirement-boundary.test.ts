import { expect, test } from "bun:test";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web";
import { callTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import type { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import type { AdapterEvent, CodexProviderConfig } from "../src/types";
import { brokerTestEndpoint, beginAcknowledgedToolInvocation, environmentXml, rawWireRequest, toolResult } from "./chatgpt-harness-fixture";

test("a retired MCP binding closes the adapter tool boundary before the stale batch can be emitted", async () => {
  const socketPath = brokerTestEndpoint(`cgw-h3-retired-boundary-${process.pid}-${Date.now()}`);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://retired-tool-boundary-${Date.now()}`,
    chatgptWeb: {
      brokerSocketPath: socketPath,
      localToolsEnabled: true,
      solAvailable: true,
      proAvailable: true,
    },
  };
  const broker = TurnBroker.forSocket(socketPath);
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let retiredProgress: ReturnType<ChatGptExternalTurnProgress["snapshot"]> | undefined;
  let lateAcknowledgementError: Error | undefined;
  let markRetirementObserved!: () => void;
  const retirementObserved = new Promise<void>(resolve => { markRetirementObserved = resolve; });
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    const prepared = await turn.prepare();
    try {
      const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
      if (!token) throw new Error("missing test turn token");
      turn.onSubmitted?.();
      const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
      const invocation = callTurnBroker<BrokerToolResult>(socketPath, {
        method: "invoke",
        bindingId: claimed.bindingId,
        wireName: "exec_command",
        arguments: { cmd: "stale after MCP timeout" },
      }, null);
      const invocationOutcome = invocation.then(
        value => ({ type: "value" as const, value }),
        error => ({ type: "error" as const, error: error instanceof Error ? error : new Error(String(error)) }),
      );
      const progress = turn.externalProgress;
      if (!progress) throw new Error("tool-capable browser test has no progress transport");
      let snapshot = progress.snapshot();
      while (snapshot.lastToolBatchRevision === 0) {
        snapshot = await progress.waitForChange(snapshot.revision, turn.abortSignal);
      }
      expect(snapshot.activeToolCalls).toBe(1);

      await callTurnBroker(socketPath, { method: "release", bindingId: claimed.bindingId });
      const invocationResult = await invocationOutcome;
      expect(invocationResult.type).toBe("error");
      await broker.waitForRetirement(token);
      await Promise.resolve();
      snapshot = progress.snapshot();
      retiredProgress = snapshot;
      try {
        await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
      } catch (error) {
        lateAcknowledgementError = error instanceof Error ? error : new Error(String(error));
      }
      markRetirementObserved();

      return await new Promise<string>((_resolve, reject) => {
        const rejectAborted = () => reject(turn.abortSignal?.reason ?? new DOMException("test browser aborted", "AbortError"));
        if (turn.abortSignal?.aborted) rejectAborted();
        else turn.abortSignal?.addEventListener("abort", rejectAborted, { once: true });
      });
    } finally {
      prepared.release();
    }
  };

  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(provider, { broker }).runTurn!(
      rawWireRequest(environmentXml),
      { headers: new Headers() },
      event => events.push(event),
    );
    await retirementObserved;
    expect(retiredProgress?.activeToolCalls).toBe(0);
    expect(lateAcknowledgementError?.message).toContain("retired the turn binding");
    expect(events.some(event => event.type === "tool_call_start")).toBeFalse();
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "chatgpt_submitted_turn_failed",
    });
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await broker.close();
  }
}, 10_000);

test("retiring MCP after an emitted tool round settles its browser owner before replacement", async () => {
  const socketPath = brokerTestEndpoint(`cgw-h3-post-retire-${process.pid}-${Date.now()}`);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://post-emission-retirement-${Date.now()}`,
    chatgptWeb: {
      brokerSocketPath: socketPath,
      localToolsEnabled: true,
      solAvailable: true,
      proAvailable: true,
    },
  };
  const broker = TurnBroker.forSocket(socketPath);
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let browserStarts = 0;
  let firstToken = "";
  let firstAbortSignal: AbortSignal | undefined;
  let firstPhysicallySettled = false;
  let replacementToken = "";
  let replacementAbortSignal: AbortSignal | undefined;
  let markFirstToolResultObserved!: () => void;
  const firstToolResultObserved = new Promise<void>(resolve => { markFirstToolResultObserved = resolve; });
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserStarts += 1;
    const ordinal = browserStarts;
    const prepared = await turn.prepare();
    try {
      const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
      if (!token) throw new Error("missing test turn token");
      turn.onSubmitted?.();
      if (ordinal === 1) {
        firstToken = token;
        firstAbortSignal = turn.abortSignal;
        const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
        const { result: pendingResult } = await beginAcknowledgedToolInvocation(turn, () => callTurnBroker<BrokerToolResult>(socketPath, {
          method: "invoke",
          bindingId: claimed.bindingId,
          wireName: "exec_command",
          arguments: { cmd: "first emitted round" },
        }, null));
        const result = await pendingResult;
        expect(result.structuredContent).toEqual({ output: "first tool result", exit_code: 0 });
        markFirstToolResultObserved();
        return await new Promise<string>((_resolve, reject) => {
          const rejectAborted = () => reject(turn.abortSignal?.reason ?? new DOMException("test browser aborted", "AbortError"));
          if (turn.abortSignal?.aborted) rejectAborted();
          else turn.abortSignal?.addEventListener("abort", rejectAborted, { once: true });
        });
      }
      replacementToken = token;
      replacementAbortSignal = turn.abortSignal;
      turn.onTextDelta("replacement completed");
      return "replacement completed";
    } finally {
      prepared.release();
      if (ordinal === 1) firstPhysicallySettled = true;
    }
  };

  const adapter = createChatGptWebAdapter(provider, { broker });
  const firstEvents: AdapterEvent[] = [];
  try {
    await adapter.runTurn!(
      rawWireRequest(environmentXml),
      { headers: new Headers() },
      event => firstEvents.push(event),
    );
    expect(firstEvents.at(-1)).toMatchObject({
      type: "done",
      stopReason: "tool_use",
      endTurn: false,
    });
    expect(firstAbortSignal?.aborted).toBeFalse();
    expect(firstPhysicallySettled).toBeFalse();
    const firstCall = firstEvents.find(
      (event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start",
    );
    if (!firstCall) throw new Error("first emitted tool round has no call id");
    broker.completeTool(firstToken, firstCall.id, toolResult({ output: "first tool result", exit_code: 0 }));
    await firstToolResultObserved;

    const replacementRequest = rawWireRequest(environmentXml);
    const raw = replacementRequest._rawBody as {
      client_metadata: Record<string, string>;
      input: Array<Record<string, unknown>>;
    };
    raw.client_metadata["x-codex-turn-metadata"] = JSON.stringify({
      thread_id: "thread_test_123",
      turn_id: "turn_test_replacement",
    });
    for (const item of raw.input) {
      item.internal_chat_message_metadata_passthrough = { turn_id: "turn_test_replacement" };
    }
    const replacementEvents: AdapterEvent[] = [];
    broker.revoke(firstToken, new Error("test capability retired after tool emission"));
    await Promise.race([
      adapter.runTurn!(
        replacementRequest,
        { headers: new Headers() },
        event => replacementEvents.push(event),
      ),
      Bun.sleep(1_000).then(() => {
        throw new Error("replacement remained blocked behind the retired browser owner");
      }),
    ]);

    expect(firstAbortSignal?.aborted).toBeTrue();
    expect(firstPhysicallySettled).toBeTrue();
    expect(browserStarts).toBe(2);
    expect(replacementEvents.at(-1)).toMatchObject({
      type: "done",
      stopReason: "stop",
      endTurn: true,
    });
    await broker.waitForRetirement(replacementToken);
    await Promise.resolve();
    expect(replacementAbortSignal?.aborted).toBeFalse();
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await broker.close();
  }
}, 10_000);
