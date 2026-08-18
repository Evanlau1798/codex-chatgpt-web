import { expect, test } from "bun:test";
import { browserSteeringRetry } from "../src/adapters/chatgpt-web/steering";
import { ChatGptSteeringFeed, ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint, isWindowsPipeEndpoint } from "../src/config";

test("explicit browser-turn cancellation aborts and removes every registered session", async () => {
  const sessions = new ChatGptTurnSessions();
  let cancelled = 0;
  const replayable = sessions.getOrCreate("turn-a", () => ({
    mode: "read-only",
    browser: Promise.resolve("done"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }));
  await replayable.browserOutcome;
  sessions.getOrCreate("turn-b", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }));

  expect(sessions.activeCount()).toBe(1);
  expect(sessions.clear()).toBe(2);
  expect(cancelled).toBe(2);
  expect(sessions.activeCount()).toBe(0);
});

test("retiring a completed session waits for its retained browser surface to release", async () => {
  const sessions = new ChatGptTurnSessions();
  const lifecycle: string[] = [];
  const session = sessions.getOrCreate("compacted-turn", () => ({
    mode: "read-only",
    browser: Promise.resolve("handoff"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { lifecycle.push("cancel"); },
    release: async () => { lifecycle.push("release"); },
  }));
  await session.browserOutcome;

  expect(await sessions.retireAndWait("compacted-turn")).toBeTrue();
  expect(lifecycle).toEqual(["cancel", "release"]);
  expect(sessions.find("compacted-turn")).toBeUndefined();
});

test("a synchronous failure retirement remains joinable by a concurrent compact request", async () => {
  const sessions = new ChatGptTurnSessions();
  let finishBrowser!: (answer: string) => void;
  const browser = new Promise<string>(resolve => { finishBrowser = resolve; });
  let releases = 0;
  const session = sessions.getOrCreate("compaction-race", () => ({
    mode: "read-only",
    browser,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => {},
    release: async () => { releases += 1; },
  }));

  expect(sessions.retire("compaction-race", session)).toBeTrue();
  const compactRetirement = sessions.retireAndWait("compaction-race");
  let settled = false;
  void compactRetirement.then(() => { settled = true; });
  await Bun.sleep(0);
  expect(settled).toBeFalse();

  finishBrowser("checkpoint");
  expect(await compactRetirement).toBeTrue();
  expect(releases).toBe(1);
});

test("session cache expiry never cancels a still-active long browser turn", async () => {
  const sessions = new ChatGptTurnSessions(1);
  let cancelled = 0;
  const active = sessions.getOrCreate("long-turn", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }));

  await Bun.sleep(5);
  expect(sessions.activeCount()).toBe(1);
  expect(sessions.getOrCreate("long-turn", () => {
    throw new Error("active session must be reused");
  })).toBe(active);
  expect(cancelled).toBe(0);
  sessions.clear();
});

test("session registry accepts a seventh turn for the browser FIFO scheduler", () => {
  const sessions = new ChatGptTurnSessions();
  let cancelled = 0;
  const runtime = () => ({
    mode: "read-only" as const,
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  });

  const active = Array.from({ length: 7 }, (_unused, index) => (
    sessions.getOrCreate(`turn-${index + 1}`, runtime)
  ));
  expect(sessions.activeCount()).toBe(7);
  expect(cancelled).toBe(0);

  expect(sessions.getOrCreate("turn-3", () => {
    throw new Error("an in-flight turn must be reused");
  })).toBe(active[2]);
  expect(cancelled).toBe(0);
  sessions.clear();
  expect(cancelled).toBe(7);
});

test("settled replay sessions expire from their last use instead of their creation time", async () => {
  const sessions = new ChatGptTurnSessions(50);
  let starts = 0;
  const start = () => {
    starts += 1;
    return {
      mode: "read-only" as const,
      browser: Promise.resolve("done"),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => {},
    };
  };
  const first = sessions.getOrCreate("replay", start);
  await first.browserOutcome;
  await Bun.sleep(10);
  expect(sessions.getOrCreate("replay", start)).toBe(first);
  await Bun.sleep(70);
  expect(sessions.getOrCreate("replay", start)).not.toBe(first);
  expect(starts).toBe(2);
  sessions.clear();
});

test("turn broker creates its private runtime directory on a cold start", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    }, 10_000);
    if (process.platform === "win32") {
      expect(isWindowsPipeEndpoint(socketPath)).toBe(true);
    } else {
      expect(existsSync(socketPath)).toBe(true);
      expect(statSync(dirname(socketPath)).mode & 0o777).toBe(0o700);
    }
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn broker tokens do not expire while their browser turn is still alive", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-unbounded-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
    expect(token).toMatch(/^turn_[a-f0-9]{32}$/);
    await Bun.sleep(5);
    await expect(callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token }))
      .resolves.toMatchObject({ bindingId: expect.any(String) });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("context archive reads report progress to the owning browser turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-progress-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  let progress = 0;
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    }, 10_000, "progress-turn", () => { progress += 1; });
    const context = await broker.registerContext("archived context", 10_000, "progress-turn", token);

    await callTurnBroker(socketPath, { method: "read_context", token: context });

    expect(progress).toBe(1);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn broker distinguishes queued and immediately delivered handoff instructions", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-handoff-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const environment = {
    cwd: root,
    roots: [root],
    writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" as const },
    tools: [],
  };
  try {
    const queuedToken = await broker.register(environment);
    expect(broker.requestHandoff(queuedToken, "queued handoff")).toBe("queued");

    const deliveredToken = await broker.register(environment);
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(
      socketPath,
      { method: "claim", token: deliveredToken },
    );
    const invocation = callTurnBroker<{ content: Array<{ type: string; text: string }>; isError: boolean }>(
      socketPath,
      { method: "invoke", bindingId, wireName: "mcp__example__read", arguments: {} },
    );
    await broker.nextToolBatch(deliveredToken);

    expect(broker.requestHandoff(deliveredToken, "delivered handoff")).toBe("delivered");
    await expect(invocation).resolves.toMatchObject({
      content: [{ type: "text", text: "delivered handoff" }],
      isError: true,
    });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("compaction control transactions accept one structured handoff and consume it once", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-compaction-control-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const transaction = await broker.beginCompactionTransaction("trace-compaction-control", 10_000);
    expect(transaction.token).toMatch(/^control_[a-f0-9]{32}$/);
    expect(transaction.handoffId).toMatch(/^handoff_[a-f0-9]{32}$/);

    const waiting = broker.waitForCompactionHandoff(transaction.token);
    await expect(callTurnBroker(socketPath, {
      method: "submit_compaction_handoff",
      token: transaction.token,
      handoffId: transaction.handoffId,
      summary: "Structured checkpoint preserved the current implementation state.",
    })).resolves.toEqual({ submitted: true });

    await expect(waiting).resolves.toBe("Structured checkpoint preserved the current implementation state.");
    await expect(callTurnBroker(socketPath, {
      method: "submit_compaction_handoff",
      token: transaction.token,
      handoffId: transaction.handoffId,
      summary: "Duplicate checkpoint.",
    })).rejects.toThrow();
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("compaction control tokens cannot claim work capability and reject mismatched handoff ids", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-compaction-scope-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const transaction = await broker.beginCompactionTransaction("trace-compaction-scope", 10_000);
    await expect(callTurnBroker(socketPath, { method: "claim", token: transaction.token }))
      .rejects.toThrow("invalid");
    await expect(callTurnBroker(socketPath, {
      method: "submit_compaction_handoff",
      token: transaction.token,
      handoffId: "handoff_00000000000000000000000000000000",
      summary: "Structured checkpoint.",
    })).rejects.toThrow("handoff");
    broker.abortCompactionTransaction(transaction.token);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("compaction control transactions fail closed on unusable summaries, timeout, and abort", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-compaction-terminal-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const invalid = await broker.beginCompactionTransaction("trace-compaction-invalid", 10_000);
    await expect(callTurnBroker(socketPath, {
      method: "submit_compaction_handoff",
      token: invalid.token,
      handoffId: invalid.handoffId,
      summary: "I cannot create a checkpoint summary because the context is not accessible.",
    })).rejects.toThrow("usable");
    broker.abortCompactionTransaction(invalid.token);

    const timed = await broker.beginCompactionTransaction("trace-compaction-timeout", 5);
    await expect(broker.waitForCompactionHandoff(timed.token)).rejects.toThrow("timed out");

    const aborted = await broker.beginCompactionTransaction("trace-compaction-abort", 10_000);
    const waiting = broker.waitForCompactionHandoff(aborted.token);
    broker.abortCompactionTransaction(aborted.token);
    await expect(waiting).rejects.toThrow("aborted");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn broker delivers steering once through the active tool loop", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-steering-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const first = callTurnBroker<{ content: Array<{ type: string; text: string }>; isError: boolean }>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
    });
    await Bun.sleep(5);
    expect(broker.requestSteering(token, "The user added: stop and review first")).toBe("delivered");
    const delivered = await first;
    expect(delivered.isError).toBeUndefined();
    expect(delivered.content[0]?.text).toContain("The user added: stop and review first");
    expect(delivered.content[0]?.text).toContain("control message, not evidence that the command failed");

    expect(broker.requestSteering(token, "The user added: use the existing implementation")).toBe("queued");
    const queued = await callTurnBroker<{ content: Array<{ type: string; text: string }>; isError?: boolean }>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
    });
    expect(queued.isError).toBeUndefined();
    expect(queued.content[0]?.text).toContain("The user added: use the existing implementation");
    expect(queued.content[0]?.text).toContain("only rerun it if it remains necessary");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("queued steering becomes a same-conversation follow-up when no tool call consumes it", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-steering-fallback-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
    const instruction = "The user added this instruction while you were working:\n\nReview live progress first.";
    expect(broker.requestSteering(token, instruction)).toBe("queued");

    const retry = browserSteeringRetry(
      new ChatGptSteeringFeed(),
      "steering-fallback",
      undefined,
      () => broker.takeUndeliveredSteering(token),
    );
    expect(retry("premature answer", 1)).toBe(
      `${instruction}\n\nContinue the task in this same conversation. Treat this as the latest user instruction.`,
    );
    expect(retry("completed after guidance", 2)).toBeUndefined();
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function unansweredBrokerEndpoint(name: string, onConnection: (socket: Socket) => void) {
  const root = mkdtempSync(join(tmpdir(), name));
  const socketPath = defaultBrokerEndpoint(root);
  if (!isWindowsPipeEndpoint(socketPath)) mkdirSync(dirname(socketPath), { recursive: true });
  const server = createServer(onConnection);
  return {
    socketPath,
    listen: () => new Promise<void>(ready => server.listen(socketPath, ready)),
    close: async () => {
      await new Promise<void>(done => server.close(() => done()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("an unbounded broker call fails when the broker closes without answering", async () => {
  const broker = unansweredBrokerEndpoint("cgw-broker-closed-", socket => socket.on("data", () => socket.end()));
  await broker.listen();
  try {
    await expect(callTurnBroker(broker.socketPath, { method: "claim", token: "turn_closed" }, null))
      .rejects.toThrow("closed the connection");
  } finally {
    await broker.close();
  }
}, 10_000);

test("an unbounded broker call outlives the bounded default timeout", async () => {
  const accepted: Socket[] = [];
  const broker = unansweredBrokerEndpoint("cgw-broker-slow-", socket => { accepted.push(socket); });
  await broker.listen();
  try {
    const call = callTurnBroker(broker.socketPath, { method: "claim", token: "turn_unbounded" }, null);
    const outcome = await Promise.race([
      call.then(() => "settled", () => "settled"),
      Bun.sleep(5_300).then(() => "pending"),
    ]);
    expect(outcome).toBe("pending");
  } finally {
    for (const socket of accepted) socket.destroy();
    await broker.close();
  }
}, 15_000);

test("turn broker names the finished turn that owns a replayed handle", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    }, 60_000, "turn-alpha");
    await expect(callTurnBroker(socketPath, { method: "claim", token: ` ${token}` }))
      .rejects.toThrow("turn token is invalid, expired, or revoked");
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    broker.revoke(token);

    const rejection = async (request: Parameters<typeof callTurnBroker>[1]): Promise<string> => {
      try {
        await callTurnBroker(socketPath, request);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("turn broker accepted a handle it should have rejected");
    };

    const replayedBinding = await rejection({
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
    });
    expect(replayedBinding).toContain("turn-alpha");
    expect(replayedBinding).toContain("has already finished");
    expect(replayedBinding).not.toContain("codex_bind_turn");

    const replayedToken = await rejection({ method: "claim", token });
    expect(replayedToken).toContain("turn-alpha");
    expect(replayedToken).toContain("can no longer run");
    expect(replayedToken).not.toContain("current task context");

    const unknownBinding = await rejection({
      method: "invoke",
      bindingId: "binding_never-issued",
      wireName: "exec_command",
    });
    expect(unknownBinding).toBe("internal Codex turn binding is invalid or expired");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
