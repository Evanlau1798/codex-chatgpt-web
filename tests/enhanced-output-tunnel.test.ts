import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { decideTunneledDomFallbackFinal, runChatGptTunneledOutputTurn } from "../src/adapters/chatgpt-web/tunneled-output-turn";
import type { BrokerTurnOutputEvent } from "../src/adapters/chatgpt-web/turn-broker-protocol";
import { defaultConfig } from "../src/config";
import type { CodexParsedRequest } from "../src/types";

const TURN_TOKEN = "turn_12345678901234567890123456789012";

function toolRequest(): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    context: {
      systemPrompt: ["Follow the task instructions."],
      messages: [{ role: "user", content: "Inspect the repository.", timestamp: 1 }],
      tools: [{ name: "Read", description: "Read a file", parameters: {} }],
    },
    stream: true,
    options: { reasoning: "medium" },
  };
}

test("Enhanced Native prompts bind visible output to the existing Codex tool gateway", () => {
  const compiled = compileChatGptWebPrompt(
    toolRequest(),
    { localToolsEnabled: true, solAvailable: true, proAvailable: true },
    TURN_TOKEN,
    { nativeControlConnector: true, useEnhancedOutputTunnel: true },
  ).text;

  expect(compiled).toContain("codex.control.output");
  expect(compiled).toContain("commentary");
  expect(compiled).toContain("reasoning");
  expect(compiled).toContain("final");
  expect(compiled.match(new RegExp(TURN_TOKEN, "g"))).toHaveLength(1);
});

test("manual, compaction, and Luna checkpoint prompts keep their dedicated output paths", () => {
  const capabilities = { localToolsEnabled: true, solAvailable: true, proAvailable: true };
  const compile = (request: CodexParsedRequest, options: Record<string, unknown>) => compileChatGptWebPrompt(
    request, capabilities, TURN_TOKEN, { nativeControlConnector: true, useEnhancedOutputTunnel: true, ...options },
  ).text;
  expect(compile(toolRequest(), { manualControl: true })).not.toContain("codex.control.output");
  expect(compile({ ...toolRequest(), _compactionRequest: true }, {})).not.toContain("codex.control.output");
  expect(compileChatGptWebPrompt(
    { ...toolRequest(), modelId: "gpt-5.6-luna" },
    { localToolsEnabled: true, solAvailable: false, proAvailable: false },
    TURN_TOKEN,
    { nativeControlConnector: true, useEnhancedOutputTunnel: true, captureLunaCheckpoint: true },
  ).text).not.toContain("codex.control.output");
  expect(compileChatGptWebPrompt(
    { ...toolRequest(), modelId: "gpt-5.6-luna" },
    { localToolsEnabled: true, solAvailable: false, proAvailable: false },
    TURN_TOKEN,
    { nativeControlConnector: true, useEnhancedOutputTunnel: true },
  ).text).not.toContain("codex.control.output");
});

test("Enhanced output tunneling is enabled by default", () => {
  expect((defaultConfig("full") as unknown as Record<string, unknown>).useEnhancedOutputTunnel).toBe(true);
});

test("tunneled output commits only after Web completion and preserves feed order", async () => {
  const events: BrokerTurnOutputEvent[] = [
    { sequence: 1, kind: "commentary", text: "Working." },
    { sequence: 2, kind: "reasoning", text: "Verified the boundary." },
    { sequence: 3, kind: "final", text: "Complete." },
  ];
  const projected: string[] = [];
  let committed = 0;
  const decision = await runChatGptTunneledOutputTurn({
    output: queue(events), attempt: 1,
    observe: async () => ({ running: false, responsePresent: true }),
    completionFence: { begin: async () => 3, commit: async revision => { committed = revision; return true; } },
    onCommentary: text => projected.push(`commentary:${text}`),
    onReasoning: text => projected.push(`reasoning:${text}`),
    onFinal: text => projected.push(`final:${text}`),
    pollMs: 1,
  });
  expect(decision).toEqual({ status: "complete", answer: "Complete." });
  expect(projected).toEqual(["commentary:Working.", "reasoning:Verified the boundary.", "final:Complete."]);
  expect(committed).toBe(3);
});

test("tunneled output acknowledges native tool batches without reading rich DOM text", async () => {
  let acknowledgements = 0;
  const decision = await runChatGptTunneledOutputTurn({
    output: queue([{ sequence: 1, kind: "final", text: "Complete." }]),
    attempt: 1,
    acknowledgeToolBatch: async () => { acknowledgements += 1; },
    observe: async () => ({ running: false, responsePresent: true }),
    onFinal: () => {},
    pollMs: 1,
  });
  expect(decision.status).toBe("complete");
  expect(acknowledgements).toBeGreaterThan(0);
});

test("tunneled final resets before a same-surface answer retry", async () => {
  let reset = 0;
  const output = queue([{ sequence: 1, kind: "final", text: "Premature." }], value => { reset = value; });
  const decision = await runChatGptTunneledOutputTurn({
    output, attempt: 1,
    observe: async () => ({ running: false, responsePresent: true }),
    retryPromptForAnswer: async () => "Continue with the requested tool.",
    onFinal: () => {},
    pollMs: 1,
  });
  expect(decision).toEqual({ status: "retry", retry: { text: "Continue with the requested tool." }, lastSequence: 1 });
  expect(reset).toBe(1);
});

test("missing tunneled final falls back without resubmitting the Web prompt", async () => {
  let observations = 0;
  const decision = await runChatGptTunneledOutputTurn({
    output: queue([]), attempt: 1,
    observe: async () => { observations += 1; return { running: false, responsePresent: true }; },
    onFinal: () => { throw new Error("unexpected final"); },
    pollMs: 1,
    fallbackGraceMs: 0,
  });
  expect(decision).toEqual({ status: "fallback", lastSequence: 0 });
  expect(observations).toBe(2);
});

test("DOM fallback cannot discard output accepted before the broker seal", async () => {
  let resolve!: (event: BrokerTurnOutputEvent) => void;
  const pending = new Promise<BrokerTurnOutputEvent>(done => { resolve = done; });
  const decision = await runChatGptTunneledOutputTurn({
    output: {
      next: (after, signal) => after < 1 ? pending : new Promise<BrokerTurnOutputEvent>((_, reject) => signal?.addEventListener(
        "abort", () => reject(new DOMException("aborted", "AbortError")), { once: true },
      )),
      reset: async () => {},
      seal: async () => {
        resolve({ sequence: 1, kind: "final", text: "Authoritative final." });
        return false;
      },
    },
    attempt: 1,
    observe: async () => ({ running: false, responsePresent: true }),
    onFinal: () => {},
    pollMs: 1,
    fallbackGraceMs: 0,
  });
  expect(decision).toEqual({ status: "complete", answer: "Authoritative final." });
});

test("a preemptive retry without a final does not replay earlier tunneled output", async () => {
  const events: BrokerTurnOutputEvent[] = [
    { sequence: 1, kind: "commentary", text: "Once." },
  ];
  let commentary = 0;
  const first = await runChatGptTunneledOutputTurn({
    output: queue(events), attempt: 1,
    observe: async () => ({ running: false, responsePresent: true }),
    takePreemptiveRetry: () => "Continue.",
    onCommentary: () => { commentary += 1; },
    onFinal: () => {},
    pollMs: 1,
  });
  expect(first).toEqual({ status: "retry", retry: { text: "Continue." }, lastSequence: 1 });
  if (first.status !== "retry") throw new Error("expected retry");
  events.push({ sequence: 2, kind: "final", text: "Done." });
  const second = await runChatGptTunneledOutputTurn({
    output: queue(events), attempt: 2,
    afterSequence: first.lastSequence,
    observe: async () => ({ running: false, responsePresent: true }),
    onCommentary: () => { commentary += 1; },
    onFinal: () => {},
    pollMs: 1,
  });
  expect(second.status).toBe("complete");
  expect(commentary).toBe(1);
});

test("preemptive retry drains a final that arrived during the stopping observation", async () => {
  let resolve!: (event: BrokerTurnOutputEvent) => void;
  let reset = 0;
  const pending = new Promise<BrokerTurnOutputEvent>(done => { resolve = done; });
  const decision = await runChatGptTunneledOutputTurn({
    output: {
      next: (after, signal) => after < 1 ? pending : new Promise<BrokerTurnOutputEvent>((_, reject) => signal?.addEventListener(
        "abort", () => reject(new DOMException("aborted", "AbortError")), { once: true },
      )),
      reset: async sequence => { reset = sequence; },
      seal: async () => true,
    },
    attempt: 1,
    observe: async () => {
      resolve({ sequence: 1, kind: "final", text: "Old answer." });
      return { running: false, responsePresent: true, toolCallsInFlight: false };
    },
    takePreemptiveRetry: () => "Continue.",
    onFinal: () => {},
    pollMs: 1,
  });
  expect(decision).toEqual({ status: "retry", retry: { text: "Continue." }, lastSequence: 1 });
  expect(reset).toBe(1);
});

test("missing final waits for active native tools before DOM fallback", async () => {
  let observations = 0;
  const decision = await runChatGptTunneledOutputTurn({
    output: queue([]), attempt: 1,
    observe: async () => ({
      running: false,
      responsePresent: true,
      toolCallsInFlight: ++observations === 1,
    }),
    onFinal: () => {},
    pollMs: 1,
    fallbackGraceMs: 0,
  });
  expect(decision).toEqual({ status: "fallback", lastSequence: 0 });
  expect(observations).toBe(3);
});

test("DOM fallback rechecks tools that start during its final output wait", async () => {
  let observations = 0;
  const decision = await runChatGptTunneledOutputTurn({
    output: queue([]), attempt: 1,
    observe: async () => ({
      running: false,
      responsePresent: true,
      toolCallsInFlight: ++observations === 2,
    }),
    onFinal: () => {},
    pollMs: 1,
    fallbackGraceMs: 0,
  });
  expect(decision).toEqual({ status: "fallback", lastSequence: 0 });
  expect(observations).toBeGreaterThanOrEqual(4);
});

test("DOM fallback seals completion before checking for pending steering", async () => {
  let sealed = false;
  await expect(decideTunneledDomFallbackFinal({
    answer: "Old final.",
    attempt: 1,
    retryPromptForAnswer: async () => {
      expect(sealed).toBeTrue();
      return "Apply new steering.";
    },
    completionAdmission: {
      seal: () => { sealed = true; return true; },
      reopen: () => { sealed = false; },
    },
  })).rejects.toMatchObject({ original: { code: "chatgpt_tunneled_fallback_retry_required" } });
  expect(sealed).toBeTrue();
});

test("a completion revision race never publishes a stale tunneled final", async () => {
  let commits = 0;
  let finals = 0;
  const decision = await runChatGptTunneledOutputTurn({
    output: queue([{ sequence: 1, kind: "final", text: "Stable." }]), attempt: 1,
    observe: async () => ({ running: false, responsePresent: true }),
    completionFence: {
      begin: async () => commits,
      commit: async () => { commits += 1; return commits > 1; },
    },
    onFinal: () => { finals += 1; },
    pollMs: 1,
  });
  expect(decision).toEqual({ status: "complete", answer: "Stable." });
  expect(commits).toBe(2);
  expect(finals).toBe(1);
});

test("successful tunnel completion precedes rich DOM response traversal", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src/adapters/chatgpt-web/browser-worker.ts"), "utf8");
  const tunnel = source.indexOf("runChatGptTunneledOutputTurn({");
  const richDom = source.indexOf("this.responseDomSnapshot(responseTurn", tunnel);
  expect(tunnel).toBeGreaterThan(-1);
  expect(richDom).toBeGreaterThan(tunnel);
  expect(source.slice(tunnel, richDom)).toContain('if (tunneled.status === "complete")');
  expect(source.slice(tunnel, richDom)).toContain("break;");
});

test("tunneled browser turns use content-free completion diagnostics", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src/adapters/chatgpt-web/browser-worker.ts"), "utf8");
  expect(source).toMatch(/new ChatGptBrowserDiagnostics\(\s*turn\.traceId,\s*this\.config\.browserDiagnosticsPath,\s*turn\.tunneledOutput !== undefined,\s*\)/);
});

test("tunnel observation failures fail closed instead of retrying an ambiguous output epoch", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src/adapters/chatgpt-web/browser-worker.ts"), "utf8");
  const tunnel = source.indexOf("runChatGptTunneledOutputTurn({");
  const genericRetry = source.indexOf("const retryPrompt = chatGptTerminalErrorRetryPrompt", tunnel);
  const failClosed = source.lastIndexOf("if (turn.tunneledOutput) throw error", genericRetry);
  expect(failClosed).toBeGreaterThan(tunnel);
  expect(failClosed).toBeLessThan(genericRetry);
});

test("production wiring requires Enhanced mode before enabling tunneled output", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src/adapters/chatgpt-web/adapter-runtime-factory.ts"), "utf8");
  expect(source).toContain("const nativeControlConnector = useEnhancedWebSessionMode && configuredCapabilities.localToolsEnabled");
  expect(source).toContain("requested: nativeControlConnector && useEnhancedOutputTunnel");
});

function queue(events: BrokerTurnOutputEvent[], onReset: (sequence: number) => void = () => {}) {
  return {
    next: (after: number, signal?: AbortSignal) => {
      const ready = events.find(event => event.sequence > after);
      if (ready) return Promise.resolve(ready);
      return new Promise<BrokerTurnOutputEvent>((_, reject) => signal?.addEventListener(
        "abort", () => reject(new DOMException("aborted", "AbortError")), { once: true },
      ));
    },
    reset: async (sequence: number) => { onReset(sequence); },
    seal: async () => true,
  };
}
