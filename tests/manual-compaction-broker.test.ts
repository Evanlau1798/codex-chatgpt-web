import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runManualCompaction } from "../src/adapters/chatgpt-web/manual-compaction";
import { createZeroRiskRuntimeStarter } from "../src/adapters/chatgpt-web/zero-risk-runtime";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { canonicalizeCompactionHandoff } from "../src/adapters/chatgpt-web/compaction-handoff";
import { deferred } from "../src/adapters/chatgpt-web/runtime-lifecycle";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import { defaultBrokerEndpoint } from "../src/config";
import type { CodexParsedRequest } from "../src/types";

test("manual compact revokes queued broker work before releasing the source and starting its checkpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-compact-queue-"));
  const socket = defaultBrokerEndpoint(root), broker = TurnBroker.forSocket(socket), key = randomUUID();
  const started = deferred<void>(), ending = deferred<void>(), release = deferred<void>();
  const capabilities = { localToolsEnabled: true, solAvailable: false, proAvailable: false };
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, stream: true, options: { reasoning: "low" },
    context: { tools: [{ name: "exec_command", description: "Inspect files", parameters: { type: "object" } }],
      messages: [{ role: "user", content: "Inspect the project", timestamp: 1 }] },
  };
  let requestId = "", checkpointStarted = false;
  const start = createZeroRiskRuntimeStarter({
    broker, capabilities, executionNamespace: key,
    provider: { adapter: "chatgpt-web", baseUrl: "manual://fixture", chatgptWeb: {
      browserInteractionMode: "manual", browserHost: "launcher", browserHostDescriptorPath: join(root, "launcher.json"),
    } },
    control: {
      async start(_path, activity) {
        requestId = JSON.parse(activity.prompt.match(/<codex_zero_risk_request_json>\n([^\n]+)/)![1]!).request_id;
      },
      async waitSent() {},
      waitTerminal() { broker.startSafeTurn(requestId); return new Promise<never>(() => {}); },
      async markStarted() { started.resolve(); },
      async end() { ending.resolve(); await release.promise; },
      async cancel() {},
    },
  });
  const source = chatGptTurnSessions.getOrCreate(key, () => start(parsed, {
    cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" }, tools: parsed.context.tools!,
  }, key));
  let pending: Promise<{ exit: number; output: string; errors: string }> | undefined, compact: Promise<void> | undefined;
  try {
    await started.promise;
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(socket, { method: "claim", token: requestId, contract: "safe" });
    // MCP is a separate process in production. Exercise its actual unbounded client path.
    const client = new URL("../src/adapters/chatgpt-web/turn-broker-client.ts", import.meta.url).href;
    const request = { method: "invoke", bindingId, wireName: "exec_command", freeform: false,
      arguments: { cmd: "THIS_MUST_NEVER_EXECUTE" } };
    const child = Bun.spawn([process.execPath, "--eval", `
      import { callTurnBroker } from ${JSON.stringify(client)};
      try {
        await callTurnBroker(${JSON.stringify(socket)}, ${JSON.stringify(request)}, null);
        process.exitCode = 1;
      } catch { console.log("QUEUED_INVOCATION_REJECTED"); }
    `], { stdout: "pipe", stderr: "pipe" });
    pending = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      .then(([exit, output, errors]) => ({ exit, output, errors }));
    // Observe queue insertion without delivering the request to a CLI/tool executor.
    const channels = (broker as unknown as { channels: Map<string, { queuedCallIds: string[] }> }).channels;
    const deadline = Date.now() + 1_000;
    while (!channels.get(requestId)?.queuedCallIds.length && Date.now() < deadline) await Bun.sleep(1);
    expect(channels.get(requestId)?.queuedCallIds).toHaveLength(1);
    expect(source.outstanding()).toHaveLength(0);
    const checkpoint = { ...parsed, _compactionRequest: true };
    compact = runManualCompaction({ parsed: checkpoint, sourceKey: key, executionKey: `${key}:compact`,
      traceId: key, capabilities, emit() {}, start: async () => {
        checkpointStarted = true;
        return chatGptTurnSessions.getOrCreate(`${key}:compact`, () => ({ mode: "read-only",
          browser: Promise.resolve(canonicalizeCompactionHandoff(checkpoint, "Queued work was cancelled.")!),
          trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {},
        }));
      },
    });
    await ending.promise;
    expect(await pending).toEqual({ exit: 0, output: "QUEUED_INVOCATION_REJECTED\n", errors: "" });
    expect(checkpointStarted).toBe(false);
    await expect(broker.nextToolBatch(requestId)).rejects.toThrow(/invalid|expired/);
    await expect(callTurnBroker(socket, { method: "invoke", bindingId, wireName: "exec_command", freeform: false,
      arguments: { cmd: "THIS_MUST_NOT_REPLAY" } })).rejects.toThrow(/finished|invalid|revoked/);
    release.resolve();
    await compact;
    expect(checkpointStarted).toBe(true);
    expect(chatGptTurnSessions.find(key)).toBeUndefined();
    expect(chatGptTurnSessions.find(`${key}:compact`)).toBeUndefined();
  } finally {
    release.resolve();
    await chatGptTurnSessions.retireAndWait(key);
    await chatGptTurnSessions.retireAndWait(`${key}:compact`);
    await broker.close();
    await pending;
    await compact;
    rmSync(root, { recursive: true, force: true });
  }
});
