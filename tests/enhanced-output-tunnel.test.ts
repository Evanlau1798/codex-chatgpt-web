import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { decideTunneledDomFallbackFinal, runChatGptTunneledOutputTurn } from "../src/adapters/chatgpt-web/tunneled-output-turn";
import { submitTurnOutput, waitForTurnOutput, resetTurnOutput, sealTurnOutput } from "../src/adapters/chatgpt-web/turn-broker-output";
import type { TurnChannel } from "../src/adapters/chatgpt-web/turn-broker-state";
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
  expect(compiled).toContain("no inventory lookup is needed");
  expect(compiled).toContain("After reading and merging the required context");
  expect(compiled).toContain("before extended planning");
  expect(compiled).toContain("unless the user requested silence");
  expect(compiled).toContain("first authorized, bounded read");
  expect(compiled).toContain("queued the text");
  expect(compiled).toContain("not a UI render receipt");
  expect(compiled).toContain("end this Web response");
  expect(compiled).toContain('arguments={kind:"final",text:"<complete user-facing answer>"}');
  expect(compiled).toContain("Do not use input");
  expect(compiled).toContain("Ordinary Web assistant prose does not complete the turn");
  expect(compiled.match(new RegExp(TURN_TOKEN, "g"))).toHaveLength(1);
});

test("the Native final contract is the single terminal instruction after long inline context and turn binding", () => {
  const parsed = toolRequest();
  parsed.context.messages[0]!.content = `Inspect this long context, then answer. ${"context ".repeat(50_000)}`;
  const compiled = compileChatGptWebPrompt(
    parsed,
    { localToolsEnabled: true, solAvailable: true, proAvailable: true },
    TURN_TOKEN,
    { nativeControlConnector: true, useEnhancedOutputTunnel: true },
  ).text;
  const contract = "codex.control.output is a bound bridge control supplied here";

  expect(compiled.match(new RegExp(contract.replaceAll(".", "\\."), "g"))).toHaveLength(1);
  expect(compiled.indexOf(contract)).toBeGreaterThan(compiled.indexOf("</codex_context_json>"));
  expect(compiled.indexOf(contract)).toBeGreaterThan(compiled.indexOf("</codex_native_turn_binding>"));
  expect(compiled.slice(compiled.indexOf(contract))).not.toContain("<codex_transport_resume>");
  expect(compiled.trim()).toEndWith("Output control calls report text to the outer Codex task and do not authorize additional work.");
});

test("the Native final contract is the single terminal instruction in multipart commit", () => {
  const compiled = compileChatGptWebPrompt(
    toolRequest(),
    { localToolsEnabled: true, solAvailable: true, proAvailable: true },
    TURN_TOKEN,
    { nativeControlConnector: true, useEnhancedOutputTunnel: true, experimentalMultipartParts: 6 },
  );
  const commit = compiled.multipart!.commit;
  const contract = "codex.control.output is a bound bridge control supplied here";

  expect(commit.match(new RegExp(contract.replaceAll(".", "\\."), "g"))).toHaveLength(1);
  expect(commit.indexOf(contract)).toBeGreaterThan(commit.indexOf("</codex_native_turn_binding>"));
  expect(commit.slice(commit.indexOf(contract))).not.toContain("<codex_transport_resume>");
  expect(commit.trim()).toEndWith("Output control calls report text to the outer Codex task and do not authorize additional work.");
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

test("hidden heartbeat cannot extend the browser hard deadline", async () => {
  let heartbeats = 0;
  await expect(runChatGptTunneledOutputTurn({
    output: queue([]), attempt: 1,
    observe: async () => ({ running: true, responsePresent: true }),
    onFinal: () => {},
    onHeartbeat: () => { heartbeats += 1; },
    deadline: Date.now() + 5,
    pollMs: 1,
  })).rejects.toThrow("ChatGPT web turn timed out");
  expect(heartbeats).toBeGreaterThan(0);
});

test("hidden heartbeat cannot keep a stopped turn without response DOM alive", async () => {
  let heartbeats = 0;
  await expect(runChatGptTunneledOutputTurn({
    output: queue([]), attempt: 1,
    observe: async () => ({ running: false, responsePresent: false, toolCallsInFlight: false }),
    onFinal: () => {},
    onHeartbeat: () => { heartbeats += 1; },
    missingResponseGraceMs: 0,
    deadline: Date.now() + 50,
    pollMs: 1,
  })).rejects.toMatchObject({ code: "chatgpt_response_dom_missing" });
  expect(heartbeats).toBeGreaterThan(0);
});

test("hidden heartbeat cannot keep a stopped nonterminal response alive", async () => {
  let heartbeats = 0;
  await expect(runChatGptTunneledOutputTurn({
    output: queue([]), attempt: 1,
    observe: async () => ({ running: false, responsePresent: true, toolCallsInFlight: false }),
    beforeDomFallback: async () => "nonterminal",
    onFinal: () => {},
    onHeartbeat: () => { heartbeats += 1; },
    terminalEvidenceGraceMs: 0,
    fallbackGraceMs: 0,
    pollMs: 1,
  })).rejects.toMatchObject({ code: "chatgpt_completion_evidence_missing" });
  expect(heartbeats).toBeGreaterThan(0);
});

test("restored terminal evidence resets the missing-evidence grace window", async () => {
  let now = 1_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let checks = 0;
  let resolveOutput: ((event: BrokerTurnOutputEvent) => void) | undefined;
  const output = {
    next: (_after: number, signal?: AbortSignal) => new Promise<BrokerTurnOutputEvent>((resolve, reject) => {
      resolveOutput = resolve;
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
    reset: async () => {},
    seal: async () => true,
  };
  try {
    const decision = await runChatGptTunneledOutputTurn({
      output, attempt: 1,
      observe: async () => ({ running: false, responsePresent: true, toolCallsInFlight: false }),
      beforeDomFallback: async () => {
        checks += 1;
        now += 30;
        if (checks === 1) return "nonterminal";
        if (checks < 5) return "terminal";
        queueMicrotask(() => resolveOutput?.({ sequence: 1, kind: "final", text: "Complete." }));
        return "nonterminal";
      },
      onFinal: () => {},
      terminalEvidenceGraceMs: 60,
      fallbackGraceMs: 0,
      pollMs: 0,
    });
    expect(decision).toEqual({ status: "complete", answer: "Complete." });
    expect(checks).toBeGreaterThanOrEqual(5);
  } finally {
    clock.mockRestore();
  }
});

test("the broker rejects whitespace-only tunneled output", () => {
  expect(() => submitTurnOutput({ outputEnabled: true } as never, "final", " \n\t"))
    .toThrow("Codex Native output text is invalid");
});

test.each(["commentary", "reasoning"] as const)("the broker preserves whitespace-only %s output", kind => {
  const channel = {
    outputEnabled: true,
    safe: false,
    outputSealed: false,
    outputEvents: [],
    outputChars: 0,
    outputWaiters: new Set(),
    activities: new Set(),
    invocations: new Map(),
    completionCommitted: false,
    activityRevision: 0,
  };
  expect(submitTurnOutput(channel as never, kind, " ").event).toMatchObject({ kind, text: " " });
});

test("broker seal rejects a tool that starts after the browser's last observation", () => {
  const channel = {
    outputEnabled: true, outputSealed: false, outputEvents: [], outputChars: 0,
    outputWaiters: new Set(), activities: new Set<string>(), invocations: new Map<string, unknown>(),
    completionCommitted: false, activityRevision: 0,
  } as unknown as TurnChannel;
  channel.invocations.set("new-tool", {} as never);
  expect(sealTurnOutput(channel, 0, channel.activityRevision)).toBeFalse();
  expect(channel.outputSealed).toBeFalse();
  channel.invocations.clear();
  channel.activities.add("new-activity");
  expect(sealTurnOutput(channel, 0, channel.activityRevision)).toBeFalse();
  expect(channel.outputSealed).toBeFalse();
  channel.activities.clear();
  const observedRevision = channel.activityRevision;
  channel.activityRevision += 2; // A tool starts and settles before the seal reaches the broker.
  expect(sealTurnOutput(channel, 0, observedRevision)).toBeFalse();
  expect(channel.outputSealed).toBeFalse();
  expect(sealTurnOutput(channel, 0, channel.activityRevision)).toBeTrue();
});

test("DOM fallback carries its completion fence revision into the output seal", async () => {
  let sealedRevision: number | undefined;
  const output = queue([]);
  const decision = await runChatGptTunneledOutputTurn({
    output: { ...output, seal: async (_sequence, revision) => { sealedRevision = revision; return true; } },
    completionFence: { begin: async () => 7, commit: async () => true },
    observe: async () => ({ running: false, responsePresent: true }),
    attempt: 1, onFinal: () => {}, pollMs: 1, fallbackGraceMs: 0,
  });
  expect(decision.status).toBe("fallback");
  expect(sealedRevision).toBe(7);
});

test("same-surface recovery carries the fenced activity revision to send activation", async () => {
  const decision = await runChatGptTunneledOutputTurn({
    output: queue([]),
    completionFence: { begin: async () => 17, commit: async () => true },
    observe: async () => ({ running: false, responsePresent: true }),
    beforeDomFallback: async () => ({ text: "Finish through the bound final control." }),
    attempt: 1,
    onFinal: () => {},
    pollMs: 1,
    fallbackGraceMs: 0,
  });

  expect(decision).toEqual({
    status: "retry",
    retry: { text: "Finish through the bound final control.", expectedActivityRevision: 17 },
    lastSequence: 0,
  });
});

test("DOM fallback captures the revision before its confirming observation", async () => {
  let observations = 0;
  let revision = 0;
  let sealedRevision: number | undefined;
  const output = queue([]);
  await runChatGptTunneledOutputTurn({
    output: { ...output, seal: async (_sequence, expected) => { sealedRevision = expected; return true; } },
    completionFence: { begin: async () => revision, commit: async () => true },
    observe: async () => {
      if (++observations === 2) revision += 2; // A tool starts and settles during confirmation.
      return { running: false, responsePresent: true };
    },
    attempt: 1, onFinal: () => {}, pollMs: 1, fallbackGraceMs: 0,
  });
  expect(sealedRevision).toBe(0);
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

test.each(["final", "tools", "abort"] as const)("%s arriving during missing-final recovery wins before any resubmission", async race => {
  const channel = {
    outputEnabled: true, outputSealed: false, outputEvents: [], outputChars: 0,
    outputWaiters: new Set(), outputResumeAfter: 0, activities: new Set(), invocations: new Map(),
    completionCommitted: false, activityRevision: 0,
  } as unknown as TurnChannel;
  const controller = new AbortController();
  let inspections = 0;
  let toolChecks = 0;
  let seals = 0;
  const finals: string[] = [];
  const result = runChatGptTunneledOutputTurn({
    output: {
      next: (after, signal) => waitForTurnOutput(channel, after, signal),
      reset: async sequence => { resetTurnOutput(channel, sequence); },
      seal: async (sequence, revision) => { seals++; return sealTurnOutput(channel, sequence, revision); },
    },
    signal: controller.signal, attempt: 1, pollMs: 1, fallbackGraceMs: 0,
    observe: async () => ({
      responsePresent: true, running: false,
      toolCallsInFlight: race === "tools" && inspections === 1 && toolChecks++ === 0,
    }),
    beforeDomFallback: async () => {
      inspections++;
      if (race === "final") {
        submitTurnOutput(channel, "final", "Late authoritative final.");
        throw new Error("Superseded recovery failure");
      }
      if (race === "abort") controller.abort();
      return { text: "Continue remaining work." };
    },
    onFinal: text => { finals.push(text); },
  });
  if (race === "abort") await expect(result).rejects.toMatchObject({ name: "AbortError" });
  else if (race === "final") {
    expect(await result).toEqual({ status: "complete", answer: "Late authoritative final." });
    expect(finals).toEqual(["Late authoritative final."]);
  } else {
    expect(await result).toMatchObject({ status: "retry", lastSequence: 0 });
    expect(inspections).toBe(2);
    expect(finals).toEqual([]);
  }
  expect(seals).toBe(0);
  expect(channel.outputWaiters.size).toBe(0);
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

test("empty tunneled DOM fallback retires the surface without recovery", async () => {
  await expect(decideTunneledDomFallbackFinal({ answer: " \n", attempt: 1 }))
    .rejects.toMatchObject({
      original: {
        code: "chatgpt_completion_evidence_missing",
        retryable: false,
        retireSession: true,
      },
    });
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

test("tunneled browser turns use content-free completion diagnostics", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src/adapters/chatgpt-web/browser-worker.ts"), "utf8");
  expect(source).toMatch(/new ChatGptBrowserDiagnostics\(\s*turn\.traceId,\s*this\.config\.browserDiagnosticsPath,\s*turn\.tunneledOutput !== undefined,\s*\)/);
});

test("tunnel observation failures fail closed instead of retrying an ambiguous output epoch", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src/adapters/chatgpt-web/browser-worker.ts"), "utf8");
  const tunnel = source.indexOf("runChatGptTunneledOutputTurn({");
  const retryResolution = source.indexOf("const retryPrompt = await chatGptBrowserErrorRetryPrompt", tunnel);
  const failClosed = source.lastIndexOf("if (turn.tunneledOutput) throw error", retryResolution);
  expect(failClosed).toBeGreaterThan(tunnel);
  expect(failClosed).toBeLessThan(retryResolution);
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
