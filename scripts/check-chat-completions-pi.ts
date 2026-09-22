import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";
import { ChatGptAccountSafety } from "../src/adapters/chatgpt-web/account-safety";
import { createChatCompletionExecutor, activeChatCompletionTurns } from "../src/chat-completions/runtime";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptMarkdownBuffer } from "../src/adapters/chatgpt-web/markdown";
import { ChatCompletionError } from "../src/chat-completions/contract";
import { runPiNativeBrokerProbe } from "./chat-completions-pi-native";

/** Real unmodified pi CLI, production HTTP/compiler/output/runtime with a scripted model worker.
 * Offline protocol/integration proof, not logged-in ChatGPT inference or Windows release acceptance.
 */
async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !arg.startsWith("--pi=") && !arg.startsWith("--node="))) throw new Error("Use --pi=<installed pi cli.js> --node=<installed Node executable>");
  const pi = resolve(args.find(arg => arg.startsWith("--pi="))?.slice(5) ?? "");
  const node = resolve(args.find(arg => arg.startsWith("--node="))?.slice(7) ?? "");
  if (!existsSync(pi) || !existsSync(node) || !args.length) throw new Error("Supply existing pi and Node executables; this script does not install clients");
  const temporary = mkdtempSync(join(tmpdir(), "chat-pi-"));
  const agentDir = join(temporary, "agent"); const work = join(temporary, "work");
  mkdirSync(agentDir); mkdirSync(work);
  const key = randomBytes(32).toString("base64url");
  const oldKey = process.env.CODEX_CHATGPT_WEB_API_KEY; const oldHome = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_API_KEY = key; process.env.CODEX_CHATGPT_WEB_HOME = join(temporary, "service");
  const config = { ...defaultConfig(), port: 0 };
  const report: Record<string, unknown> = { evidence: "real-pi-offline-scripted-worker", platform: process.platform,
    bun: Bun.version, nodeVersion: Bun.spawnSync([node, "--version"]).stdout.toString().trim(),
    worktreeDirty: Bun.spawnSync(["git", "diff", "--quiet"]).exitCode !== 0, commit: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(), cases: [] };
  const results = report.cases as Array<Record<string, unknown>>;
  let mode: "tools" | "isolation" | "steer" | "resume" | "error" | "cancel" | "text" | "structured-text" | "compact" | "compact-error" | "compact-hold" = "tools";
  let calls = 0; let toolResults = 0; let cancellationObserved = false;
  const isolationTraces = new Map<string, Set<string>>();
  let isolationArrivals = 0;
  let releaseIsolation!: () => void;
  const isolationBarrier = new Promise<void>(resolve => { releaseIsolation = resolve; });
  let steerStarted!: () => void;
  let releaseSteer!: () => void;
  let markSteerObserved!: () => void;
  const steerReady = new Promise<void>(resolve => { steerStarted = resolve; });
  const steerBarrier = new Promise<void>(resolve => { releaseSteer = resolve; });
  const steerObserved = new Promise<void>(resolve => { markSteerObserved = resolve; });
  let steerCalls = 0;
  let resumeCalls = 0;
  const resumeTraces = new Set<string>();
  let cancelStarted!: () => void;
  const cancelReady = new Promise<void>(r => { cancelStarted = r; });
  const project = (turn: BrowserTurn, answer: string, html?: string) => {
    const buffer = new ChatGptMarkdownBuffer(undefined, 0, turn.outputFormat);
    const escaped = answer.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    buffer.observe([{ key: "answer", tag: "p", html: html ?? (answer.startsWith("PI_") && !turn.outputFormat
      ? `<p><code>${escaped}</code></p>` : `<p>${escaped}</p>`), text: answer, streamable: false }]);
    const visible = buffer.finish().markdown;
    turn.onTextDelta(visible);
    return visible;
  };
  let summaryCalls = 0;
  let compactFollowUps = 0;
  const compactTraces = new Map<string, Set<string>>();
  let summaryArrivals = 0;
  let releaseSummaries!: () => void;
  const summaryBarrier = new Promise<void>(resolve => { releaseSummaries = resolve; });
  const longMarkdown = `PI_LONG_MARKER\n# Heading\n\n- item with \\path and literal \\n\n`.repeat(160);
  const structuredContent = 'line one\nline two\\n C:\\work\\file "quoted" _[brackets] 漢字';
  const readFixture = `INERT_PI_FIXTURE\n${'line with \\path, literal \\n, and 漢字\n'.repeat(180)}`;
  let holdSummaryStarted!: () => void;
  const summaryHeld = new Promise<void>(resolve => { holdSummaryStarted = resolve; });
  const safety = new ChatGptAccountSafety(join(temporary, "safety.json"));
  const executor = createChatCompletionExecutor({ safety, worker: provider => {
    if (provider.chatgptWeb?.localToolsEnabled !== false) throw new Error("Unexpected local tool authority");
    return { async run(turn: BrowserTurn) {
      calls++;
      if (turn.nativeConnector || turn.conversationKey || turn.retainConversation || turn.capabilities.localToolsEnabled) throw new Error("Unexpected native or retained capability");
      const prepared = await turn.prepare(); prepared.release();
      const payload = JSON.parse(prepared.text.slice(prepared.text.indexOf('{"messages"')));
      if (mode === "text") {
        if (!JSON.stringify(payload.messages).includes(JSON.stringify(longMarkdown).slice(1, -1))) throw new Error("Long Pi input changed in the model prompt");
        return project(turn, "# Heading\n\n- item\n\n`code`", "<h1>Heading</h1><ul><li>item</li></ul><p><code>code</code></p>");
      }
      if (mode === "structured-text") {
        const hasResult = payload.messages.some((message: { role: string }) => message.role === "tool");
        return project(turn, JSON.stringify(hasResult
          ? { content: `**done**\n- item\n${structuredContent}`, tool_calls: [] }
          : { content: null, tool_calls: [{ name: "write", arguments: { path: "structured.txt", content: structuredContent } }] }));
      }
      if (mode === "compact" || mode === "compact-error" || mode === "compact-hold") {
        const history = JSON.stringify(payload.messages);
        const owners = ["ALPHA", "BRAVO", "AUTO", "FAIL"].filter(value => history.includes(`PI_COMPACT_${value}`));
        if (owners.length !== 1) throw new Error("Compaction request lost or mixed Pi session owners");
        const owner = owners[0]!;
        const traces = compactTraces.get(owner) ?? new Set<string>();
        traces.add(turn.traceId); compactTraces.set(owner, traces);
        const summary = history.includes("Create a structured context checkpoint summary");
        if (summary) {
          if (payload.tools.length || turn.outputFormat || turn.capabilities.localToolsEnabled) throw new Error("Pi summarizer received tool authority");
          summaryCalls++;
          if (mode === "compact-error") throw new ChatCompletionError("Synthetic summary failure", 502, "model_protocol_error");
          if (mode === "compact-hold") {
            holdSummaryStarted();
            await new Promise<void>(resolve => {
              if (turn.abortSignal?.aborted) resolve(); else turn.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
            });
            turn.abortSignal!.throwIfAborted();
          }
          if (owner === "ALPHA" || owner === "BRAVO") {
            summaryArrivals++;
            if (summaryArrivals === 2) releaseSummaries();
            await Promise.race([summaryBarrier, Bun.sleep(10_000).then(() => { throw new Error("Concurrent Pi compactions did not overlap"); })]);
          }
          return project(turn, `PI_SUMMARY_${owner}`);
        }
        if (history.includes(`PI_COMPACT_${owner}_FOLLOWUP`)) {
          if (!history.includes(`PI_SUMMARY_${owner}`) || history.includes("PI_SUMMARY_" + (owner === "ALPHA" ? "BRAVO" : "ALPHA"))) {
            throw new Error("Pi compact follow-up lost or mixed its summary");
          }
          compactFollowUps++;
          return project(turn, `PI_COMPACT_${owner}_DONE`);
        }
        return project(turn, `PI_COMPACT_${owner}_SEED_ACK`);
      }
      if (mode === "resume") {
        resumeCalls++;
        resumeTraces.add(turn.traceId);
        const history = JSON.stringify(payload.messages);
        if (!history.includes("PI_RESUME_MARKER")
          || (resumeCalls === 2 && !history.includes("PI_RESUME_ACK"))
          || resumeCalls > 2) throw new Error("Pi resume lost or mixed its local session history");
        const answer = resumeCalls === 1 ? "PI_RESUME_ACK" : "PI_RESUME_CONFIRMED";
        return project(turn, answer);
      }
      if (mode === "steer") {
        steerCalls++;
        if (steerCalls === 1) {
          steerStarted();
          await steerBarrier;
        } else if (steerCalls === 2 && JSON.stringify(payload.messages).includes("PI_STEER_MARKER")) {
          markSteerObserved();
        } else throw new Error("Pi steering reached the wrong model turn");
        const answer = steerCalls === 1 ? "Initial work segment finished." : "PI_STEER_CONFIRMED";
        return project(turn, answer);
      }
      if (mode === "isolation") {
        const history = JSON.stringify(payload.messages);
        const owners = ["ALPHA", "BRAVO"].filter(value => history.includes(`PI_ISOLATION_${value}`));
        if (owners.length !== 1) throw new Error("Pi request mixed concurrent session histories");
        const owner = owners[0]!;
        const traces = isolationTraces.get(owner) ?? new Set<string>();
        traces.add(turn.traceId);
        isolationTraces.set(owner, traces);
        const results = payload.messages.filter((message: { role: string }) => message.role === "tool");
        if (results.length === 0) {
          isolationArrivals++;
          if (isolationArrivals === 2) releaseIsolation();
          await Promise.race([isolationBarrier, Bun.sleep(10_000).then(() => { throw new Error("Pi sessions did not overlap at the Web boundary"); })]);
        }
        if (results.length === 1 && !results[0].content.includes(`PI_ISOLATION_${owner}`)) {
          throw new Error("Pi tool result belonged to the other session");
        }
        const answer = JSON.stringify(results.length === 0
          ? { content: null, tool_calls: [{ name: "read", arguments: { path: "input.txt" } }] }
          : results.length === 1
            ? { content: null, tool_calls: [{ name: "write", arguments: { path: "result.txt", content: `PI_ISOLATION_${owner}_OK\n` } }] }
            : { content: `PI_ISOLATION_${owner}_OK`, tool_calls: [] });
        return project(turn, answer);
      }
      if (mode === "error") throw new ChatCompletionError("Synthetic model failure", 502, "model_protocol_error");
      if (mode === "cancel") {
        cancelStarted();
        await new Promise<void>(resolve => {
          const done = () => { cancellationObserved = true; resolve(); };
          if (turn.abortSignal?.aborted) done(); else turn.abortSignal?.addEventListener("abort", done, { once: true });
        });
        turn.abortSignal!.throwIfAborted(); return "unreachable";
      }
      const historyResults = payload.messages.filter((message: { role: string }) => message.role === "tool");
      toolResults = Math.max(toolResults, historyResults.length);
      let answer: string;
      if (historyResults.length === 0) answer = JSON.stringify({ content: null, tool_calls: [{ name: "read", arguments: { path: "input.txt" } }] });
      else if (historyResults.length === 1) {
        if (historyResults[0].content !== readFixture) throw new Error("Pi changed the complete long tool result");
        answer = JSON.stringify({ content: null, tool_calls: [{ name: "write", arguments: { path: "result.txt", content: "PI_TOOL_LOOP_OK\n" } }] });
      } else if (historyResults.length === 2) answer = JSON.stringify({ content: null, tool_calls: [{
        name: "bash", arguments: { command: "node -e \"process.stdout.write('PI_BASH_OK')\"" },
      }] });
      else {
        if (!historyResults[2]?.content.includes("PI_BASH_OK")) throw new Error("Pi did not return the command output");
        answer = JSON.stringify({ content: "PI_TOOL_LOOP_OK", tool_calls: [] });
      }
      return project(turn, answer);
    } };
  } });
  const server = startServer(config, { chatCompletionExecutor: executor });
  const env: Record<string, string> = {
    PATH: `${dirname(node)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    HOME: temporary, USERPROFILE: temporary, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", CODEX_CHATGPT_WEB_API_KEY: key,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { enhanced: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "$CODEX_CHATGPT_WEB_API_KEY", authHeader: true,
    models: [{ id: "chatgpt-web/high", name: "Enhanced offline fixture", reasoning: false, input: ["text"],
      contextWindow: 80000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: false, supportsReasoningEffort: false, supportsDeveloperRole: true,
        supportsUsageInStreaming: false, supportsStrictMode: false, maxTokensField: "max_tokens" } }],
  } } }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false } }));
  writeFileSync(join(work, "input.txt"), readFixture);
  const flags = ["--offline", "--no-session", "--no-context-files", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve", "--provider", "enhanced", "--model", "chatgpt-web/high", "--thinking", "off"];
  const runPrint = async (extra: string[], cwd = work) => {
    const child = Bun.spawn([node, pi, ...flags, "--mode", "json", "--print", ...extra], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 30000);
    try {
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      // Only synthetic diagnostics are kept locally; report never embeds requests, keys, paths or transcripts.
      if (err) writeFileSync(join(temporary, "last-stderr.txt"), err);
      return { out, code, err };
    } finally { clearTimeout(timeout); }
  };
  const openRpc = (name: string) => {
    const sessionDir = join(temporary, `compact-${name}`); mkdirSync(sessionDir);
    const child = Bun.spawn([node, pi, ...flags.filter(flag => flag !== "--no-session"),
      "--session-dir", sessionDir, "--mode", "rpc", "--no-tools"],
    { cwd: work, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const events: Array<Record<string, any>> = [];
    const output = (async () => {
      const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let pending = "";
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          pending += decoder.decode(chunk.value, { stream: true });
          let end: number;
          while ((end = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
            if (line) events.push(JSON.parse(line));
          }
        }
      } finally { reader.releaseLock(); }
    })();
    const errors = new Response(child.stderr).text();
    return {
      events, sessionDir,
      async send(value: Record<string, unknown>) { child.stdin.write(JSON.stringify(value) + "\n"); await child.stdin.flush(); },
      async until(predicate: (event: Record<string, any>) => boolean, after = 0) {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const found = events.slice(after).find(predicate); if (found) return found;
          if (child.exitCode !== null) throw new Error(`Pi RPC exited before event (${child.exitCode})`);
          await Bun.sleep(20);
        }
        throw new Error(`Pi RPC event timed out: ${name}`);
      },
      async close() { child.stdin.end(); child.kill(); await child.exited; await output; await errors; },
    };
  };
  try {
    const version = Bun.spawnSync([node, pi, "--version"], { cwd: work, env });
    report.piVersion = version.stdout.toString().trim();
    const loop = await runPrint(["--tools", "read,write,bash", "Read input.txt, write the fixed fixture result, run the inert command check, then finish."]);
    if (loop.code !== 0 || !existsSync(join(work, "result.txt")) || readFileSync(join(work, "result.txt"), "utf8") !== "PI_TOOL_LOOP_OK\n"
      || toolResults !== 3 || calls !== 4 || !loop.out.includes("PI_TOOL_LOOP_OK")) {
      console.error(loop.err); console.error(loop.out.slice(-5000)); throw new Error(`pi tool loop failed: exit=${loop.code}, requests=${calls}, results=${toolResults}`);
    }
    results.push({ case: "tool-and-command-rounds", status: "PASS", requests: calls, toolResults, resultFileMatched: true, nativeCapabilities: 0 });
    mode = "isolation";
    const separate = ["ALPHA", "BRAVO"] as const;
    const folders = separate.map(owner => {
      const folder = join(temporary, owner.toLowerCase());
      mkdirSync(folder);
      writeFileSync(join(folder, "input.txt"), `PI_ISOLATION_${owner}\n`);
      return folder;
    });
    const beforeIsolation = calls;
    const simultaneous = await Promise.all(separate.map((owner, index) =>
      runPrint(["--tools", "read,write", `Handle PI_ISOLATION_${owner}: read input.txt, write result.txt with the required result, then finish.`], folders[index])));
    if (calls !== beforeIsolation + 6 || simultaneous.some(value => value.code !== 0)
      || separate.some((owner, index) => readFileSync(join(folders[index]!, "result.txt"), "utf8") !== `PI_ISOLATION_${owner}_OK\n`)) {
      throw new Error("Concurrent pi sessions did not preserve their own model/tool response ownership");
    }
    if (isolationTraces.get("ALPHA")?.size !== 3 || isolationTraces.get("BRAVO")?.size !== 3
      || [...isolationTraces.get("ALPHA")!].some(trace => isolationTraces.get("BRAVO")!.has(trace))) {
      throw new Error("Concurrent Pi requests reused another session's Web trace");
    }
    results.push({ case: "concurrent-session-isolation", status: "PASS", sessions: 2, requests: calls - beforeIsolation, distinctWebTraces: true });
    mode = "steer";
    const steering = Bun.spawn([node, pi, ...flags, "--mode", "rpc", "--no-tools"],
      { cwd: work, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const steeringOutput = new Response(steering.stdout).text();
    const steeringErrors = new Response(steering.stderr).text();
    try {
      steering.stdin.write('{"type":"prompt","message":"Start the inert Pi steering probe."}\n');
      await steering.stdin.flush();
      await Promise.race([steerReady, Bun.sleep(15_000).then(() => { throw new Error("Pi steering first request did not start"); })]);
      steering.stdin.write('{"type":"steer","message":"PI_STEER_MARKER: finish the existing task."}\n');
      await steering.stdin.flush();
      releaseSteer();
      await Promise.race([steerObserved, Bun.sleep(15_000).then(() => { throw new Error("Pi steering was not delivered to the next Web request"); })]);
      const steerDeadline = Date.now() + 10_000;
      while (activeChatCompletionTurns() !== 0 && Date.now() < steerDeadline) await Bun.sleep(20);
      if (activeChatCompletionTurns() !== 0 || steerCalls !== 2) throw new Error("Pi steering did not settle its follow-up Web request");
      results.push({ case: "rpc-steering", status: "PASS", deliveredToFollowUp: true });
    } finally {
      steering.stdin.end(); steering.kill(); await steering.exited; await steeringOutput; await steeringErrors;
    }
    mode = "resume";
    const sessionDir = join(temporary, "pi-sessions");
    mkdirSync(sessionDir);
    const savedFlags = flags.filter(flag => flag !== "--no-session");
    const savedRun = async (extra: string[]) => {
      const child = Bun.spawn([node, pi, ...savedFlags, "--session-dir", sessionDir, "--no-tools", "--mode", "json", "--print", ...extra],
        { cwd: work, env, stdout: "pipe", stderr: "pipe" });
      const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0 || output.includes('"stopReason":"error"')) throw new Error(`Pi saved session failed (${code}): ${error.slice(0, 300)}`);
    };
    await savedRun(["Remember PI_RESUME_MARKER and finish."]);
    const savedSessions = readdirSync(sessionDir, { recursive: true }).filter((value): value is string => typeof value === "string" && value.endsWith(".jsonl"));
    if (savedSessions.length !== 1) throw new Error("Pi did not persist exactly one local session");
    const aged = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(join(sessionDir, savedSessions[0]!), aged, aged);
    await savedRun(["--continue", "Resume the aged session using the prior result."]);
    if (resumeCalls !== 2 || resumeTraces.size !== 2) {
      throw new Error("Aged Pi session did not replay its complete local history through fresh Web requests");
    }
    results.push({ case: "aged-session-resume", status: "PASS", agedHours: 2, freshWebRequests: 2 });
    mode = "text";
    const rendered = await runPrint(["--no-tools", longMarkdown]);
    const renderedFinal = rendered.out.split("\n").filter(Boolean).map(line => JSON.parse(line))
      .findLast(event => event.type === "agent_end")?.messages?.at(-1)?.content?.[0]?.text;
    if (rendered.code !== 0 || renderedFinal !== "# Heading\n\n- item\n\n`code`") {
      throw new Error("Pi long Markdown input or visible Markdown output changed");
    }
    results.push({ case: "long-input-and-markdown-output", status: "PASS", inputChars: longMarkdown.length });
    mode = "structured-text";
    const structured = await runPrint(["--tools", "write", "Write the requested structured fixture and finish."]);
    const structuredEvents = structured.out.split("\n").filter(Boolean).map(line => JSON.parse(line));
    const structuredFinal = structuredEvents.findLast(event => event.type === "agent_end")?.messages?.at(-1)?.content?.[0]?.text;
    if (structured.code !== 0 || readFileSync(join(work, "structured.txt"), "utf8") !== structuredContent
      || structuredFinal !== `**done**\n- item\n${structuredContent}`) {
      throw new Error("Pi structured tool argument or final Markdown text was altered");
    }
    results.push({ case: "structured-tool-and-final-text", status: "PASS", exactFile: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } },
      compaction: { enabled: true, reserveTokens: 2048, keepRecentTokens: 1 } }));
    mode = "compact";
    const compactOwner = async (owner: "ALPHA" | "BRAVO") => {
      const rpc = openRpc(owner.toLowerCase());
      try {
        for (let n = 0; n < 2; n++) {
          const after = rpc.events.length;
          await rpc.send({ type: "prompt", message: `PI_COMPACT_${owner} seed ${n}` });
          await rpc.until(event => event.type === "agent_end", after);
        }
        const after = rpc.events.length;
        await rpc.send({ id: `compact-${owner}`, type: "compact" });
        const response = await rpc.until(event => event.type === "response" && event.id === `compact-${owner}`, after);
        const ending = await rpc.until(event => event.type === "compaction_end" && event.reason === "manual", after);
        if (!response.success || ending.aborted || !ending.result?.summary.includes(`PI_SUMMARY_${owner}`)) throw new Error("Pi manual compact failed");
        const files = readdirSync(rpc.sessionDir, { recursive: true }).filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".jsonl"));
        if (files.length !== 1 || !readFileSync(join(rpc.sessionDir, files[0]!), "utf8").split("\n").some(line => {
          try { const entry = JSON.parse(line); return entry.type === "compaction" && entry.summary?.includes(`PI_SUMMARY_${owner}`); }
          catch { return false; }
        })) {
          throw new Error("Pi did not persist its compacted summary");
        }
        const follow = rpc.events.length;
        await rpc.send({ type: "prompt", message: `PI_COMPACT_${owner}_FOLLOWUP` });
        await rpc.until(event => event.type === "agent_settled", follow);
        const final = rpc.events.slice(follow).findLast(event => event.type === "agent_end")?.messages?.at(-1);
        if (final?.stopReason !== "stop" || !final.content?.some((part: { type: string; text?: string }) =>
          part.type === "text" && part.text?.includes(`PI_COMPACT_${owner}_DONE`))) throw new Error("Pi compact follow-up did not finish successfully");
      } finally { await rpc.close(); }
    };
    const beforeCompact = summaryCalls;
    await Promise.all([compactOwner("ALPHA"), compactOwner("BRAVO")]);
    if (summaryCalls !== beforeCompact + 2 || compactFollowUps !== 2 || (compactTraces.get("ALPHA")?.size ?? 0) < 4
      || (compactTraces.get("BRAVO")?.size ?? 0) < 4 || [...compactTraces.get("ALPHA")!].some(id => compactTraces.get("BRAVO")!.has(id))) {
      throw new Error("Concurrent Pi compactions did not preserve summary/trace ownership");
    }
    results.push({ case: "manual-compact-concurrent-isolation", status: "PASS", sessions: 2, summaryCalls: 2, followUps: 2 });
    const modelsPath = join(agentDir, "models.json");
    const models = JSON.parse(readFileSync(modelsPath, "utf8"));
    models.providers.enhanced.models[0].contextWindow = 16000;
    writeFileSync(modelsPath, JSON.stringify(models));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } },
      compaction: { enabled: false, reserveTokens: 9000, keepRecentTokens: 1 } }));
    const auto = openRpc("auto");
    try {
      for (let n = 0; n < 2; n++) {
        const after = auto.events.length;
        await auto.send({ type: "prompt", message: `PI_COMPACT_AUTO seed ${n} ${"x".repeat(15000)}` });
        await auto.until(event => event.type === "agent_end", after);
      }
      const beforeAuto = summaryCalls;
      const setting = auto.events.length;
      await auto.send({ id: "enable-auto", type: "set_auto_compaction", enabled: true });
      if (!(await auto.until(event => event.type === "response" && event.id === "enable-auto", setting)).success) throw new Error("Pi refused auto compaction");
      const after = auto.events.length;
      await auto.send({ type: "prompt", message: "PI_COMPACT_AUTO_FOLLOWUP" });
      const compacted = await auto.until(event => event.type === "compaction_end" && event.reason === "threshold", after);
      await auto.until(event => event.type === "agent_settled", after);
      const final = auto.events.slice(after).findLast(event => event.type === "agent_end")?.messages?.at(-1);
      if (compacted.aborted || !compacted.result?.summary.includes("PI_SUMMARY_AUTO") || summaryCalls !== beforeAuto + 1
        || Number(compactFollowUps) !== 3 || final?.stopReason !== "stop" || !final.content?.some((part: { type: string; text?: string }) =>
          part.type === "text" && part.text?.includes("PI_COMPACT_AUTO_DONE"))
        || auto.events.slice(after).filter(event => event.type === "compaction_end").length !== 1) {
        throw new Error("Pi auto compaction did not produce one usable summary before follow-up");
      }
      results.push({ case: "auto-compact-and-follow-up", status: "PASS", summaryCalls: 1, followUp: true });
    } finally { await auto.close(); }
    mode = "compact-error";
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } },
      compaction: { enabled: true, reserveTokens: 2048, keepRecentTokens: 1 } }));
    const failed = openRpc("failed");
    try {
      for (let n = 0; n < 2; n++) {
        const after = failed.events.length;
        await failed.send({ type: "prompt", message: `PI_COMPACT_FAIL seed ${n}` });
        await failed.until(event => event.type === "agent_end", after);
      }
      const after = failed.events.length;
      await failed.send({ id: "failing-compact", type: "compact" });
      const response = await failed.until(event => event.type === "response" && event.id === "failing-compact", after);
      const ending = await failed.until(event => event.type === "compaction_end" && event.reason === "manual", after);
      const files = readdirSync(failed.sessionDir, { recursive: true }).filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".jsonl"));
      if (response.success || ending.result || files.some(file => readFileSync(join(failed.sessionDir, file), "utf8").split("\n").some(line => {
        try { return JSON.parse(line).type === "compaction"; } catch { return false; }
      }))) throw new Error("Pi persisted a failed summary as compaction");
      results.push({ case: "compact-summary-error", status: "PASS", noCompactionEntry: true });
    } finally { await failed.close(); }
    mode = "compact-hold";
    const interrupted = openRpc("interrupted");
    try {
      for (let n = 0; n < 2; n++) {
        const after = interrupted.events.length;
        await interrupted.send({ type: "prompt", message: `PI_COMPACT_FAIL seed ${n}` });
        await interrupted.until(event => event.type === "agent_end", after);
      }
      const after = interrupted.events.length;
      await interrupted.send({ id: "held-compact", type: "compact" });
      await Promise.race([summaryHeld, Bun.sleep(15_000).then(() => { throw new Error("Pi compact did not reach the held Web turn"); })]);
      await interrupted.send({ id: "abort-summary", type: "abort" });
      const ending = await interrupted.until(event => event.type === "compaction_end" && event.reason === "manual", after);
      await interrupted.until(event => event.type === "response" && event.id === "held-compact", after);
      const files = readdirSync(interrupted.sessionDir, { recursive: true }).filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".jsonl"));
      if (!ending.aborted || ending.result || files.some(file => readFileSync(join(interrupted.sessionDir, file), "utf8").split("\n").some(line => {
        try { return JSON.parse(line).type === "compaction"; } catch { return false; }
      }))) throw new Error("Pi persisted an interrupted summary as compaction");
      results.push({ case: "compact-summary-cancel", status: "PASS", noCompactionEntry: true });
    } finally { await interrupted.close(); }
    mode = "error"; const before = calls;
    const failure = await runPrint(["--no-tools", "Exercise an intentional offline model error."]);
    if (calls !== before + 1 || !failure.out.includes('"stopReason":"error"')) {
      console.error(failure.err); console.error(failure.out.slice(-3000)); throw new Error("pi did not classify the SSE error or attempted retries");
    }
    results.push({ case: "sse-error", status: "PASS", requests: calls - before, clientClassifiedError: true, exitCode: failure.code });
    mode = "cancel";
    const child = Bun.spawn([node, pi, ...flags, "--mode", "rpc", "--no-tools"], { cwd: work, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const stdout = new Response(child.stdout).text(); const stderr = new Response(child.stderr).text();
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      child.stdin.write(JSON.stringify({ type: "prompt", message: "Hold the inert offline turn for cancellation." }) + "\n"); child.stdin.flush();
      await Promise.race([cancelReady, new Promise<never>((_, reject) => { cancelTimer = setTimeout(() => reject(new Error("pi cancellation request did not reach runtime")), 15000); })]);
      child.stdin.write('{"type":"abort"}\n'); child.stdin.flush();
      const until = Date.now() + 10000;
      while ((!cancellationObserved || activeChatCompletionTurns() !== 0) && Date.now() < until) await Bun.sleep(20);
      if (!cancellationObserved || activeChatCompletionTurns() !== 0) throw new Error("pi cancellation did not settle the original runtime");
      results.push({ case: "rpc-cancel", status: "PASS", cancellationObserved, activeBrowserTurns: activeChatCompletionTurns() });
    } finally { if (cancelTimer) clearTimeout(cancelTimer); child.stdin.end(); child.kill(); await child.exited; await stdout; await stderr; }
    results.push(await runPiNativeBrokerProbe({ temporary, agentDir, safety, runPrint }));
    report.status = "PASS";
  } finally {
    await server.stop(true);
    if (oldKey === undefined) delete process.env.CODEX_CHATGPT_WEB_API_KEY; else process.env.CODEX_CHATGPT_WEB_API_KEY = oldKey;
    if (oldHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = oldHome;
    const dest = resolve(import.meta.dir, "../tmp/chat-completions"); mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "pi-result.json"), JSON.stringify(report, null, 2));
    rmSync(temporary, { recursive: true, force: true });
  }
  console.log(JSON.stringify(report, null, 2));
}
await main();
