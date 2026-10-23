import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { defaultBrokerEndpoint } from "../src/config";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { deferred, withAbort } from "../src/adapters/chatgpt-web/runtime-lifecycle";
import { callTurnBroker, RemoteTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { NativeObserverHandoff } from "../src/adapters/chatgpt-web/native-observer-handoff";
import { submitNativeOutputControl } from "../src/adapters/chatgpt-web/native-output-control";
import { sessionForChatGptRequest } from "../src/adapters/chatgpt-web/steering";
import { ChatGptTurnSessions, ChatGptTraceFeed, ChatGptTextFeed } from "../src/adapters/chatgpt-web/turn-execution";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

function request(): CodexParsedRequest {
  const environment = `<environment_context><cwd>${process.cwd()}</cwd><filesystem><workspace_roots><root>${process.cwd()}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`;
  return {
    modelId: CHATGPT_WEB_MODEL_ID, stream: true, options: { reasoning: "high" },
    _canonicalContextComplete: true,
    context: { tools: [{ name: "exec_command", description: "Read", parameters: { type: "object" } }],
      messages: [{ role: "user", content: environment, timestamp: 1 }, { role: "user", content: "Review the files", timestamp: 2 }] },
    _rawBody: { prompt_cache_key: "thread_observer_handoff", client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: "thread_observer_handoff", turn_id: "turn_observer_handoff" }),
    }, input: [environment, "Review the files"].map((text, index) => ({
      type: "message", role: "user", id: `message_${index}`, content: [{ type: "input_text", text }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_observer_handoff" },
    })) },
  };
}

test("queued native input reattaches its accepted Web response after sampling HTTP cancellation", async () => {
  const path = join(tmpdir(), `cgw-observer-${process.pid}-${Date.now()}`);
  const socket = process.platform === "win32" ? defaultBrokerEndpoint(path, "win32") : `${path}.sock`;
  const broker = TurnBroker.forSocket(socket);
  const submitted = deferred<string>();
  const finish = deferred<string>();
  let starts = 0;
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: `browser://${path}`, chatgptWeb: {
    brokerSocketPath: socket, localToolsEnabled: true, solAvailable: true, proAvailable: true, useEnhancedWebSessionMode: true,
  } };
  const adapter = createChatGptWebAdapter(provider, { worker: { run: async (turn: BrowserTurn) => {
    starts++;
    const prepared = await turn.prepare();
    try {
      const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
      if (!token) throw new Error("Missing native token");
      turn.onSendActivated?.();
      turn.onSubmitted?.();
      submitted.resolve(token);
      const answer = await withAbort(finish.promise, turn.abortSignal);
      turn.onTextDelta(answer);
      return answer;
    } finally { prepared.release(); }
  } } });
  const disconnect = new AbortController();
  const initial = request();
  const first = adapter.runTurn!(initial, { headers: new Headers(), abortSignal: disconnect.signal }, () => {});
  const firstFailure = first.catch(error => error);
  try {
    const token = await Promise.race([submitted.promise, first.then(() => { throw new Error("Turn ended before submission"); })]);
    disconnect.abort();
    expect((await firstFailure).name).toBe("AbortError");
    const revised = structuredClone(initial);
    const raw = revised._rawBody as { input: unknown[] };
    raw.input.push({ type: "message", role: "user", id: "queued_review_update",
      content: [{ type: "input_text", text: "Also inspect ownership" }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_observer_handoff" } });
    revised.context.messages.push({ role: "user", content: "Also inspect ownership", timestamp: 3 });
    const events: AdapterEvent[] = [];
    const second = adapter.runTurn!(revised, { headers: new Headers() }, event => events.push(event));
    const secondFailure = second.catch(error => error);
    const claim = await callTurnBroker<{ bindingId: string }>(socket, { method: "claim", token });
    const result = await callTurnBroker<BrokerToolResult>(socket, { method: "invoke", bindingId: claim.bindingId,
      wireName: "exec_command", arguments: { cmd: "read" } });
    expect(JSON.stringify(result)).toContain("Also inspect ownership");
    expect(starts).toBe(1);
    finish.resolve("Review completed with the queued update.");
    expect(await secondFailure).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  } finally {
    finish.resolve("cleanup");
    chatGptTurnSessions.clear();
    await broker.close();
  }
});

async function withBroker(run: (broker: TurnBroker, remote: RemoteTurnBroker, socket: string, token: string) => Promise<void>) {
  const path = join(tmpdir(), `cgw-oh-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
  const socket = process.platform === "win32" ? defaultBrokerEndpoint(path, "win32") : `${path}.sock`;
  const broker = TurnBroker.forSocket(socket);
  try {
    const token = await broker.register({ cwd: process.cwd(), roots: [process.cwd()], writableRoots: [process.cwd()],
      sandboxPolicy: { type: "dangerFullAccess" }, tools: [] }, undefined, "handoff_edges", undefined, true);
    await run(broker, new RemoteTurnBroker(socket), socket, token);
  } finally { await broker.close(); }
}

test("detached owner holds atomic final and fences until steering has been applied", async () => {
  await withBroker(async (broker, remote, socket, token) => {
    const revision = broker.beginCompletionFence(token)!;
    expect(await remote.setObserverConnected(token, false)).toBeTrue();
    let settled = false;
    const final = callTurnBroker(socket, { method: "submit_output", token, outputKind: "final", outputText: "Premature answer" })
      .then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    await Bun.sleep(25);
    expect(settled).toBeFalse();
    expect(broker.beginCompletionFence(token)).toBeUndefined();
    expect(broker.commitCompletionFence(token, revision)).toBeFalse();
    expect(broker.beginFinalizationOnly(token, revision)).toBeFalse();
    expect(broker.sealOutput(token, 0, revision)).toBeFalse();
    broker.requestSteering(token, "Inspect the new ownership requirement");
    expect(await remote.setObserverConnected(token, true)).toBeTrue();
    expect(await final).toMatchObject({ value: { accepted: false, reason: "steering",
      instruction: expect.stringContaining("new ownership requirement") } });
    // The final control itself delivered the instruction; an answer-only update needs no work tool.
    expect(await callTurnBroker(socket, { method: "submit_output", token, outputKind: "final", outputText: "Complete answer" }))
      .toMatchObject({ accepted: true, sequence: 1 });
    expect((await broker.nextOutput(token, 0)).text).toBe("Complete answer");
  });
});

test.each(["claim", "invoke", "submit_output"] as const)("revocation wakes detached %s without resurrecting capability", async method => {
  await withBroker(async (broker, remote, socket, token) => {
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(socket, { method: "claim", token });
    expect(await remote.setObserverConnected(token, false)).toBeTrue();
    let settled = false;
    const pending = callTurnBroker(socket, { method, token, bindingId, wireName: "read_file", outputKind: "final", outputText: "No" })
      .then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    await Bun.sleep(15);
    expect(settled).toBeFalse();
    broker.revoke(token);
    expect((await pending as { error: Error }).error.message).toMatch(/invalid|finished/);
    expect(await remote.setObserverConnected(token, true)).toBeFalse();
  });
});

test("handoff expires without a new instruction and never renews its reconnect budget", async () => {
  const handoff = new NativeObserverHandoff();
  let retired = 0;
  const first = handoff.attach("first");
  handoff.detach(first, () => true, () => { retired++; }, 50);
  expect(handoff.canAttach("first")).toBeFalse();
  expect(handoff.canAttach("second")).toBeTrue();
  const second = handoff.attach("second");
  await Bun.sleep(30);
  handoff.detach(second, () => true, () => { retired++; }, 5_000);
  await Bun.sleep(40);
  expect(retired).toBe(1);
  expect(handoff.preserves(first)).toBeFalse();
  expect(handoff.preserves(second)).toBeFalse();
});

test("a disconnected MCP caller cannot start work when its paused owner reconnects", async () => {
  await withBroker(async (broker, remote, socket, token) => {
    const activityId = "activity_disconnected123456";
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(socket, { method: "claim", token, activityId });
    await callTurnBroker(socket, { method: "activity_complete", token, activityId });
    await remote.setObserverConnected(token, false);
    const abort = new AbortController();
    const invocation = callTurnBroker(socket, { method: "invoke", bindingId, wireName: "read_file" }, null, abort.signal)
      .catch(error => error);
    await Bun.sleep(20);
    abort.abort();
    await invocation;
    await Bun.sleep(20);
    await remote.setObserverConnected(token, true);
    await Bun.sleep(20);
    expect(broker.beginCompletionFence(token)).toBeNumber();
  });
});

test("late steering is a successful control reply rather than a tool failure or accepted final", async () => {
  await withBroker(async (broker, _remote, socket, token) => {
    broker.requestSteering(token, "Include LATE_NATIVE_GUIDANCE in the complete answer");
    const receipt = await submitNativeOutputControl(socket, token, { kind: "final", text: "Stale answer" }, undefined);
    expect(receipt).toMatchObject({ accepted: false, reason: "steering", instruction: expect.stringContaining("LATE_NATIVE_GUIDANCE") });
    expect(await submitNativeOutputControl(socket, token, { kind: "final", text: "Complete LATE_NATIVE_GUIDANCE answer" }, undefined))
      .toMatchObject({ accepted: true, sequence: 1 });
    expect((await broker.nextOutput(token, 0)).text).toBe("Complete LATE_NATIVE_GUIDANCE answer");
  });
});

test("a second disconnect during asynchronous resume cannot clear its retirement protection", async () => {
  const handoff = new NativeObserverHandoff();
  const connecting = deferred<boolean>();
  const resumeStarted = deferred<void>();
  let retired = 0;
  const first = handoff.attach("first");
  handoff.detach(first, connected => {
    if (!connected) return true;
    resumeStarted.resolve();
    return connecting.promise;
  }, () => { retired++; });
  const second = handoff.attach("second");
  const resuming = handoff.resume().then(value => ({ value }), error => ({ error }));
  await resumeStarted.promise;
  handoff.detach(second, () => true, () => { retired++; });
  connecting.resolve(true);
  await resuming;
  expect(retired).toBe(1);
  expect(handoff.preserves(second)).toBeFalse();
});

test("Native MCP carries late guidance as ordinary structured control and accepts one subsequent final", async () => {
  await withBroker(async (broker, _remote, socket, token) => {
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "mcp", "--broker-socket", socket], stderr: "pipe" });
    const client = new Client({ name: "native-steering-receipt", version: "1" });
    try {
      await client.connect(transport);
      broker.requestSteering(token, "LATE_MCP_UPDATE");
      const output = (text: string) => client.callTool({ name: "codex_tool_call", arguments: {
        turn_token: token, wire_name: "codex.control.output", arguments: { kind: "final", text },
      } });
      const guidance = await output("Stale final");
      expect(guidance.isError).not.toBeTrue();
      expect(guidance.structuredContent).toMatchObject({ accepted: false, reason: "steering",
        instruction: expect.stringContaining("LATE_MCP_UPDATE") });
      expect((await output("Complete LATE_MCP_UPDATE answer")).structuredContent)
        .toMatchObject({ accepted: true, sequence: 1, duplicate: false });
      expect((await broker.nextOutput(token, 0)).text).toBe("Complete LATE_MCP_UPDATE answer");
    } finally { await client.close(); }
  });
}, 15_000);

test("disconnect before pause acknowledgement never sends an unpause for the lost claim", async () => {
  const handoff = new NativeObserverHandoff();
  const paused = deferred<boolean>();
  let unpauses = 0;
  handoff.detach(handoff.attach("first"), connected => {
    if (connected) { unpauses++; return true; }
    return paused.promise;
  }, () => {});
  const second = handoff.attach("second");
  const resume = handoff.resume().catch(error => error);
  handoff.detach(second, () => true, () => {});
  paused.resolve(true);
  expect(await resume).toBeInstanceOf(Error);
  expect(unpauses).toBe(0);
  handoff.cancel();
});

test("explicit native interruption immediately retires a detached Web owner", async () => {
  const sessions = new ChatGptTurnSessions();
  const browser = deferred<string>();
  let cancelled = 0;
  const parsed = request();
  const owner = await sessionForChatGptRequest(sessions, "handoff_interrupt", parsed, () => ({
    mode: "tools", token: Promise.resolve("test_token"), browser: browser.promise,
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() { cancelled++; browser.reject(new Error("interrupted")); },
  }));
  const epoch = owner.observerHandoff.attach(owner.userRevisionKey());
  owner.observerHandoff.detach(epoch, () => true, () => { throw new Error("Expired instead of interrupted"); });
  const interrupted = sessions.cancelNativeTurn("thread_observer_handoff", "turn_observer_handoff", new Error("stop"));
  expect(interrupted.cancelled).toBe(1);
  await interrupted.settlement;
  expect(cancelled).toBe(1);
  expect(owner.observerHandoff.preserves(epoch)).toBeFalse();
});

test.each(["same_revision", "missing_history", "incomplete"])("does not retain a detached owner for %s requests", async mode => {
  const sessions = new ChatGptTurnSessions();
  let starts = 0;
  const start = () => {
    starts++;
    const browser = deferred<string>();
    return { mode: "tools" as const, token: Promise.resolve("test_token"), browser: browser.promise,
      trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() { browser.reject(new Error("retired")); } };
  };
  const first = request();
  const owner = await sessionForChatGptRequest(sessions, "handoff_proof", first, start);
  owner.observerHandoff.detach(owner.observerHandoff.attach(owner.userRevisionKey()), () => true, () => sessions.retire("handoff_proof", owner));
  const next = structuredClone(first);
  if (mode !== "same_revision") {
    const raw = next._rawBody as { input: unknown[] };
    raw.input.push({ type: "message", role: "user", id: "next", content: [{ type: "input_text", text: "More review" }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_observer_handoff" } });
    if (mode === "missing_history") raw.input.splice(1, 1);
    if (mode === "incomplete") next._canonicalContextComplete = false;
  }
  try {
    const replacement = await sessionForChatGptRequest(sessions, "handoff_proof", next, start);
    expect(replacement).not.toBe(owner);
    expect(starts).toBe(2);
  } finally { sessions.clear(); }
});

test("concurrent old finals cannot consume steering then publish a stale answer", async () => {
  await withBroker(async (broker, remote, socket, token) => {
    await remote.setObserverConnected(token, false);
    const finals = ["Old answer one", "Old answer two"].map(text =>
      submitNativeOutputControl(socket, token, { kind: "final", text }, undefined));
    await Bun.sleep(25);
    broker.requestSteering(token, "Include CONCURRENT_UPDATE");
    await remote.setObserverConnected(token, true);
    const receipts = await Promise.all(finals);
    expect(receipts.every(receipt => !receipt.accepted)).toBeTrue();
    expect(JSON.stringify(receipts)).toContain("CONCURRENT_UPDATE");
    expect(await submitNativeOutputControl(socket, token, { kind: "final", text: "Complete CONCURRENT_UPDATE" }, undefined))
      .toMatchObject({ accepted: true, sequence: 1 });
    expect((await broker.nextOutput(token, 0)).text).toBe("Complete CONCURRENT_UPDATE");
  });
});

test("disconnect during remote unpause revokes before its delayed acknowledgement", async () => {
  await withBroker(async (broker, remote, socket, token) => {
    const handoff = new NativeObserverHandoff();
    const unpauseStarted = deferred<void>();
    const unpauseAllowed = deferred<void>();
    let retired = 0;
    handoff.detach(handoff.attach("first"), async connected => {
      if (connected) { unpauseStarted.resolve(); await unpauseAllowed.promise; }
      return remote.setObserverConnected(token, connected);
    }, () => { retired++; broker.revoke(token); });
    const second = handoff.attach("second");
    const resuming = handoff.resume().catch(error => error);
    await unpauseStarted.promise;
    const waitingFinal = submitNativeOutputControl(socket, token, { kind: "final", text: "Never accepted" }, undefined)
      .catch(error => error);
    await Bun.sleep(15);
    handoff.detach(second, () => true, () => { throw new Error("Wrong owner retirement"); });
    const retiredBeforeAcknowledgement = retired;
    unpauseAllowed.resolve();
    expect(await resuming).toBeInstanceOf(Error);
    expect(await waitingFinal).toBeInstanceOf(Error);
    expect(retiredBeforeAcknowledgement).toBe(1);
    expect(retired).toBe(1);
  });
});

test("a cancelled observer never delivers a remote final accepted before revocation acknowledgement", async () => {
  const path = join(tmpdir(), `cgw-race-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
  const socket = process.platform === "win32" ? defaultBrokerEndpoint(path, "win32") : `${path}.sock`;
  const broker = TurnBroker.forSocket(socket), remote = new RemoteTurnBroker(socket);
  await broker.listen();
  const submitted = deferred<string>(), unpaused = deferred<void>(), acknowledge = deferred<void>();
  const allowRevoke = deferred<void>(), browserStopped = deferred<void>();
  const owner = new Proxy(remote, { get(target, property) {
    if (property === "setObserverConnected") return async (token: string, connected: boolean) => {
      const result = await target.setObserverConnected(token, connected);
      if (connected) { unpaused.resolve(); await acknowledge.promise; }
      return result;
    };
    if (property === "revoke") return async (token: string, reason?: Error) => {
      await allowRevoke.promise; return target.revoke(token, reason);
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const adapter = createChatGptWebAdapter({ adapter: "chatgpt-web", baseUrl: `browser://${path}`, chatgptWeb: {
    brokerSocketPath: socket, localToolsEnabled: true, solAvailable: true, proAvailable: true, useEnhancedWebSessionMode: true,
  } }, { broker: owner, worker: { run: async turn => {
    const prepared = await turn.prepare();
    try {
      const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
      if (!token) throw new Error("Missing token");
      turn.abortSignal?.addEventListener("abort", () => browserStopped.resolve(), { once: true });
      turn.onSendActivated?.(); turn.onSubmitted?.(); submitted.resolve(token);
      const final = await withAbort(broker.nextOutput(token, 0), turn.abortSignal);
      turn.onTextDelta(final.text); return final.text;
    } finally { prepared.release(); }
  } } });
  const firstAbort = new AbortController(), secondAbort = new AbortController();
  const initial = request(), events: AdapterEvent[] = [];
  const first = adapter.runTurn!(initial, { headers: new Headers(), abortSignal: firstAbort.signal }, () => {}).catch(error => error);
  try {
    const token = await Promise.race([submitted.promise, first.then(error => { throw error ?? new Error("Turn ended before send"); })]);
    firstAbort.abort(); await first;
    const next = structuredClone(initial);
    (next._rawBody as { input: unknown[] }).input.push({ type: "message", role: "user", id: "remote_update",
      content: [{ type: "input_text", text: "Latest remote instruction" }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_observer_handoff" } });
    next.context.messages.push({ role: "user", content: "Latest remote instruction", timestamp: 3 });
    const second = adapter.runTurn!(next, { headers: new Headers(), abortSignal: secondAbort.signal }, event => events.push(event))
      .catch(error => error);
    await unpaused.promise;
    expect(await submitNativeOutputControl(socket, token, { kind: "final", text: "First stale answer" }, undefined))
      .toMatchObject({ accepted: false, reason: "steering" });
    secondAbort.abort();
    await browserStopped.promise;
    // Remote cancellation has not been acknowledged; its earlier acceptance cannot reach the aborted observer.
    expect(await submitNativeOutputControl(socket, token, { kind: "final", text: "Final racing remote revoke" }, undefined))
      .toMatchObject({ accepted: true });
    acknowledge.resolve();
    expect(await second).toBeInstanceOf(Error);
    expect(events.some(event => event.type === "text_delta" || event.type === "done")).toBeFalse();
    allowRevoke.resolve(); await remote.revoke(token);
    expect(await submitNativeOutputControl(socket, token, { kind: "final", text: "After acknowledged revoke" }, undefined)
      .catch(error => error)).toBeInstanceOf(Error);
  } finally {
    acknowledge.resolve(); allowRevoke.resolve(); firstAbort.abort(); secondAbort.abort();
    chatGptTurnSessions.clear(); await broker.close();
  }
}, 15_000);
