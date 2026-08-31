import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { ChatGptTextFeed, ChatGptTraceFeed } from "../src/adapters/chatgpt-web/turn-execution";
import { ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-session-registry";
import { defaultBrokerEndpoint } from "../src/config";

const result: BrokerToolResult = { content: [{ type: "text", text: "done" }] };

test("tool result and abort orders each settle one broker invocation", async () => {
  for (const order of ["abort-first", "result-first"] as const) {
    const root = mkdtempSync(join(tmpdir(), `cgw-race-${order}-`));
    const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
    try {
      const token = await broker.register({
        cwd: root,
        roots: [root],
        writableRoots: [root],
        sandboxPolicy: { type: "dangerFullAccess" },
        tools: [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }],
      });
      const { bindingId } = await callTurnBroker<{ bindingId: string }>(
        broker.socketPath,
        { method: "claim", token },
      );
      const invocation = callTurnBroker<BrokerToolResult>(broker.socketPath, {
        method: "invoke",
        bindingId,
        wireName: "exec_command",
        freeform: false,
        arguments: { cmd: "echo race" },
      }, 2_000);
      const [request] = await broker.nextToolBatch(token);
      expect(request?.wireName).toBe("exec_command");
      if (order === "abort-first") {
        broker.revoke(token);
        await expect(invocation).rejects.toThrow(/revoked/i);
        expect(() => broker.completeTool(token, request!.callId, result)).toThrow(/invalid|expired/i);
      } else {
        broker.completeTool(token, request!.callId, result);
        await expect(invocation).resolves.toEqual(result);
        broker.revoke(token);
      }
    } finally {
      await broker.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("browser terminal and disconnect orders preserve one terminal outcome", async () => {
  for (const order of ["terminal-first", "disconnect-first"] as const) {
    const sessions = new ChatGptTurnSessions();
    let resolveBrowser!: (answer: string) => void;
    let rejectBrowser!: (error: Error) => void;
    let cancellations = 0;
    const browser = new Promise<string>((resolve, reject) => {
      resolveBrowser = resolve;
      rejectBrowser = reject;
    });
    const session = sessions.getOrCreate("race", () => ({
      mode: "read-only",
      browser,
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: (reason?: Error) => {
        cancellations += 1;
        rejectBrowser(reason ?? new Error("disconnected"));
      },
    }), undefined, undefined, undefined, "race-trace");
    if (order === "terminal-first") {
      resolveBrowser("done");
      expect(await session.browserOutcome).toEqual({ type: "final", answer: "done" });
      expect(await sessions.cancelTrace("race-trace")).toBe(0);
      expect(cancellations).toBe(0);
    } else {
      expect(await sessions.cancelTrace("race-trace")).toBe(1);
      expect((await session.browserOutcome).type).toBe("error");
      expect(cancellations).toBe(1);
    }
    sessions.clear();
  }
});

test("steering is accepted before retirement and rejected after retirement", () => {
  for (const order of ["steering-first", "retirement-first"] as const) {
    const sessions = new ChatGptTurnSessions();
    const session = sessions.getOrCreate("race", () => ({
      mode: "read-only",
      browser: new Promise<string>(() => {}),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => {},
    }), undefined, "steering-race");
    if (order === "steering-first") {
      expect(sessions.steer("steering-race", "apply once")).toBeTrue();
      expect(session.takePendingSteering()).toBe("apply once");
      expect(sessions.retire("race", session)).toBeTrue();
    } else {
      expect(sessions.retire("race", session)).toBeTrue();
      expect(sessions.steer("steering-race", "too late")).toBeFalse();
    }
  }
});

test("structured handoff submission and abort orders settle once", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-handoff-race-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    const submitted = await broker.beginCompactionTransaction("handoff-submitted", 2_000);
    const accepted = broker.waitForCompactionHandoff(submitted.token);
    await callTurnBroker(broker.socketPath, {
      method: "submit_compaction_handoff",
      token: submitted.token,
      handoffId: submitted.handoffId,
      summary: "submitted first",
    });
    broker.abortCompactionTransaction(submitted.token);
    await expect(accepted).resolves.toBe("submitted first");

    const aborted = await broker.beginCompactionTransaction("handoff-aborted", 2_000);
    const rejected = broker.waitForCompactionHandoff(aborted.token);
    broker.abortCompactionTransaction(aborted.token);
    await expect(rejected).rejects.toThrow(/aborted/i);
    await expect(callTurnBroker(broker.socketPath, {
      method: "submit_compaction_handoff",
      token: aborted.token,
      handoffId: aborted.handoffId,
      summary: "too late",
    })).rejects.toThrow(/invalid|expired/i);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
