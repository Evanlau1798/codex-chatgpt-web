import { expect, test } from "bun:test";
import { mock } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { cancelStructuredCompactionTrace } from "../src/adapters/chatgpt-web/compaction-handoff";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";
function shortSocketTempRoot(): string {
  return process.platform === "win32" ? tmpdir() : "/tmp";
}

function request(compaction = false): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    context: {
      messages: [
        { role: "user", content: "Original task", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Work completed" }], timestamp: 2 },
        { role: "user", content: "Continue with the next step", timestamp: 3 },
      ],
    },
    options: { reasoning: "high" },
    _compactionRequest: compaction,
    _rawBody: {
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue with the next step" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_source" },
      }],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_retained_compaction",
          turn_id: compaction ? "turn_compact" : "turn_source",
        }),
      },
    },
  };
}

test("fresh multipart compaction gives each acknowledged phase its own handoff budget", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-phased-fallback-compact-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://phased-fallback-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      useEnhancedWebSessionMode: true,
      solAvailable: true,
      proAvailable: true,
      turnTimeoutMs: 40,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    expect(turn.onMultipartStageAcknowledged).toBeDefined();
    expect(turn.onSubmitted).toBeDefined();
    mock.timers.tick(25);
    expect(turn.abortSignal?.aborted).toBeFalse();
    await turn.onMultipartStageAcknowledged!(1);
    mock.timers.tick(25);
    expect(turn.abortSignal?.aborted).toBeFalse();
    turn.onSubmitted!();
    mock.timers.tick(25);
    expect(turn.abortSignal?.aborted).toBeFalse();
    return "Fallback checkpoint after separately bounded phases";
  };
  const events: AdapterEvent[] = [];
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await createChatGptWebAdapter(provider).runTurn!(
      request(true),
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(events.some(event => event.type === "text_delta"
      && event.text.includes("Fallback checkpoint after separately bounded phases"))).toBeTrue();
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    mock.timers.reset();
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a timed-out fresh compaction retains its owner until helper cleanup completes", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-timeout-cleanup-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://timeout-cleanup-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      useEnhancedWebSessionMode: true,
      solAvailable: true,
      proAvailable: true,
      turnTimeoutMs: 40,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let releasePhysical!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { releasePhysical = resolve; });
  let browserStarts = 0;
  let cancelled = false;
  let fallbackTrace = "";
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserStarts += 1;
    fallbackTrace = turn.traceId;
    started();
    turn.abortSignal!.addEventListener("abort", () => { cancelled = true; }, { once: true });
    await physicalSettlement;
    return "Browser released after cancellation";
  };
  const adapter = createChatGptWebAdapter(provider);
  const events: AdapterEvent[] = [];
  const runs: Promise<void>[] = [];
  const failures: unknown[] = [];
  const observe = () => {
    const run = adapter.runTurn!(request(true), { headers: new Headers() }, event => events.push(event)).catch(error => { failures.push(error); });
    runs.push(run);
    return run;
  };
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    void observe();
    await ready;
    mock.timers.tick(41);
    await Bun.sleep(5);
    expect(cancelled).toBeTrue();
    expect(failures).toHaveLength(1);
    await observe();
    let cleanupSettled = false;
    const cleanup = cancelStructuredCompactionTrace(fallbackTrace, new Error("wait for timeout cleanup"))
      .then(count => { cleanupSettled = true; return count; });
    await Bun.sleep(5);
    expect(browserStarts).toBe(1);
    expect(cleanupSettled).toBeFalse();
    releasePhysical();
    expect(await cleanup).toBe(1);
    await Promise.all(runs);
    expect(failures).toHaveLength(2);
    expect(events.some(event => event.type === "done")).toBeFalse();
    await observe();
    expect(browserStarts).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    releasePhysical();
    await Promise.allSettled(runs);
    mock.timers.reset();
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});
